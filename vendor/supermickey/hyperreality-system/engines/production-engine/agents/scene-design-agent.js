/**
 * SceneDesignAgent - 从同一剧本镜头设计场景、情绪、动作与可见细节。
 */
const { BaseAgent } = require('./base-agent');

const GENRES = [
  'drama', 'sci-fi', 'war', 'horror', 'comedy', 'suspense', 'thriller',
  'action', 'loneliness', 'documentary', 'fantasy'
];
const DESIGN_FIELDS = ['shotId', 'scene', 'genre', 'mood', 'action', 'makeup', 'props', 'emotional_target'];

function sceneDesignSchema(shotIds) {
  return {
    type: 'object',
    required: ['shots'],
    requiredArrays: ['shots'],
    rejectEmptyArray: true,
    additionalProperties: false,
    properties: {
      shots: {
        type: 'array', minItems: shotIds.length, maxItems: shotIds.length,
        items: {
          type: 'object',
          required: DESIGN_FIELDS,
          additionalProperties: false,
          properties: {
            ...Object.fromEntries(DESIGN_FIELDS.map(field => [field, { type: 'string', minLength: 1 }])),
            shotId: { type: 'string', enum: shotIds },
            genre: { type: 'string', enum: GENRES }
          }
        }
      }
    }
  };
}

class SceneDesignAgent extends BaseAgent {
  constructor(options = {}) {
    super({ name: 'SceneDesignAgent', ...options });
  }

  _getSystemPrompt() {
    return `你是电影场景设计师。按原剧本和本次镜头合同，为给定的每一镜设计场景、情绪、动作和可见细节。
保持镜号、时长、人物身份、已定妆造、对白、地点和关键动作；只输出要求的设计字段，不重写上游镜头。
室外、室内、车内和骑乘场景按原设定写实际可见的空间、表面、道具和光源。不得加入原稿没有的角色、地点、站姿、墙壁或室内陈设。
遵守本片明确的文字与标识约束。只输出一个符合提供结构的 JSON 对象。`;
  }

  _validateSchema(data, schema) {
    const base = super._validateSchema(data, schema);
    if (!base.valid) return base;
    const shotIds = schema?.properties?.shots?.items?.properties?.shotId?.enum;
    if (!Array.isArray(shotIds)) return { valid: false, reason: '镜号合同缺失' };
    if (Object.keys(data).length !== 1 || data.shots.length !== shotIds.length) {
      return { valid: false, reason: '只允许 shots，且必须覆盖原镜头全集' };
    }
    const remaining = new Set(shotIds);
    for (const shot of data.shots) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot) || !remaining.delete(shot.shotId)) {
        return { valid: false, reason: '镜号缺失、重复或不属于原镜头' };
      }
      if (Object.keys(shot).length !== DESIGN_FIELDS.length
          || DESIGN_FIELDS.some(key => !Object.hasOwn(shot, key) || typeof shot[key] !== 'string' || !shot[key].trim())
          || !GENRES.includes(shot.genre)) {
        return { valid: false, reason: '镜头设计字段不齐、类型错误或添加了合同之外的字段' };
      }
    }
    return { valid: true };
  }

  async process(shots, blueprint) {
    console.log(`[SceneDesignAgent] 开始处理 ${shots.length} 个镜头...`);
    const shotIds = shots.map(shot => shot.shotId);
    if (!shotIds.length || shotIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(shotIds).size !== shotIds.length) {
      return { shots, degraded: true, degradeReason: '原镜号为空或重复' };
    }
    if (shots.some(({ dialogue }) => dialogue != null && typeof dialogue !== 'string'
        && (typeof dialogue !== 'object' || Array.isArray(dialogue)))) {
      return { shots, degraded: true, degradeReason: '原镜头对白字段类型无效' };
    }
    const schema = sceneDesignSchema(shotIds);
    const llmResult = await this._callLLM(this._buildPrompt(shots, blueprint), schema, () => this._fallback(shots), { critical: true });

    if (llmResult.degraded) {
      return { shots: llmResult.result?.shots || shots, degraded: true, degradeReason: llmResult.degradeReason };
    }
    // Standalone vendor fallbacks do not all run the common validator.
    const check = this._validateSchema(llmResult.result, schema);
    if (!check.valid) return { shots, degraded: true, degradeReason: check.reason };
    const designs = new Map(llmResult.result.shots.map(design => [design.shotId, design]));
    const designedShots = shots.map(shot => ({ ...shot, ...designs.get(shot.shotId) }));
    console.log('[SceneDesignAgent] 完成 ✓');
    return { shots: designedShots, degraded: false, degradeReason: null };
  }

  _buildPrompt(shots, blueprint) {
    const characters = (blueprint.character_system?.characters || []).map(character => ({
      name: character.name, description: character.description
    }));
    // Keep the current shot intact. The shared blueprint backreference is not a
    // shot field; the director context and host authority already carry its source.
    const shotSource = shots.map(shot => Object.fromEntries(Object.entries(shot).filter(([key]) => key !== '_blueprint')));

    return `${this._buildDirectorContext(blueprint)}

## 角色资料
${JSON.stringify(characters)}

## 原镜头（逐镜按源设计）
${JSON.stringify(shotSource)}

## 设计任务
1. scene：细化本镜已定空间。选择画面实际可见的环境结构、地面或承托面、自然或人工光源、现场设备和有叙事用途的环境细节。
2. mood：写明由环境、光色和气氛表现的情绪；emotional_target 给出本镜主要目标。
3. action：保留原动作、姿态、先后关系和运动方向，用重心、接触、视线与节奏表现；不要把骑乘、坐姿、奔跑、静止或无人镜头统一改成站立。
4. makeup：依据已定造型与实际可见部位描述妆发。面部被安全装备遮挡时说明遮挡，不新增摘除动作；无出镜人物时说明不适用。
5. props：按当前镜头的原道具及其实际用途设计，不能替换型号或改变安全装备；无可见道具时说明不适用。
6. genre：从 ${GENRES.join('/')} 选择一个和当前故事一致的类型。
7. 相邻镜头的空间、光线、道具和人物状态按原故事与镜头时序衔接。每个镜号恰好返回一条，不增减镜头。对白是参考证据，不改写、不补写。`;
  }

  /**
   * 【v2.1.4-fix9-P1】构建导演上下文
   */
  _buildDirectorContext(blueprint) {
    // 【v2.1.4-fix13-审计修复】兼容 adapted 对象和原始 blueprint 两种结构
    const config = blueprint.config || {};
    const meta = blueprint.metadata || blueprint.meta || {};
    const _metadata = config._metadata || blueprint._metadata || {};
    const title = meta.title || config.title || _metadata.title || '未命名';
    
    // 从多路径读取导演上下文信息
    const contentTheme = config.content_theme || _metadata.content_theme || '';
    const contentSummary = config.content_summary || _metadata.content_summary || '';
    const visualStyle = config.visual_style || _metadata.visual_style || 'REAL';
    const sceneRequirement = config.scene_requirement || _metadata.scene_requirement || '';
    const characterDescription = config.character_description || _metadata.character_description || '';
    const forbiddenScenes = config.forbidden_scenes || _metadata.forbidden_scenes || [];
    const keyMessages = config.key_messages || _metadata.key_messages || [];
    const creativeIntensity = config.creativeIntensity || _metadata.creativeIntensity || blueprint.config?.creativeIntensity || 0.5;
    
    // 【方案A-fix】原始故事文本直通：从 blueprint metadata 获取
    const originalStory = blueprint._originalStoryText || _metadata._originalStoryText || meta._originalStoryText || '';
    const storySection = originalStory ? `
## 📖 原始故事文本（镜头设计的核心依据，必须忠实还原）
${originalStory}
` : '';
    
    // 【v2.4.0-B3】全片导演风格注入：场景设计与技能路由共享同一位导演
    const filmDirectorLine = blueprint.filmDirector
      ? `\n全片导演风格：${blueprint.filmDirector}（一部片一位导演，场景光线与运镜质感向其靠齐）`
      : '';

    return `## 🎬 导演指令上下文
视频标题：${title}
内容主题：${contentTheme}
核心内容：${contentSummary}
视觉风格：${visualStyle}
创意指数：${creativeIntensity}（低创意=强制写实）
场景要求：${sceneRequirement}
角色设定：${characterDescription}
关键信息：${keyMessages.join('；') || '无'}
禁止场景：${forbiddenScenes.join('、') || '无'}
禁止元素：全息投影、虚拟空间、未来感、霓虹特效、元宇宙、数字空间、抽象几何${filmDirectorLine}
${storySection}`;
  }

  _fallback(shots) {
    console.log(`[SceneDesignAgent] 使用降级规则...`);
    return {
      shots: shots.map(shot => ({
        ...shot, // 【P1-5 修复】保留上游全部字段
        shotId: shot.shotId,
        scene: shot.scene || '',
        mood: shot.mood || '',
        action: shot.action || '',
        // ⭐ v2.1.7: 新增化妆/道具兜底
        makeup: shot.makeup || '',
        props: shot.props || '',
        emotional_target: shot.emotional_target || ''
      }))
    };
  }
}

module.exports = { SceneDesignAgent };
