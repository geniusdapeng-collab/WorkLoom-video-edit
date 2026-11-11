/**
 * Real product references outrank generic "no livery / no readable marks"
 * redactions. The latter must only suppress newly invented overlays and text,
 * never erase appearance facts that are visible in the approved reference set.
 */
export const PRODUCT_APPEARANCE_PRIORITY_VERSION = "workloom.product-appearance-priority/v1" as const;

export const PRODUCT_APPEARANCE_PRIORITY_CLAUSE =
  "【商品外观优先级】当本次绑定的真实商品参考与镜头卡中的“无涂装/无标识/无可读文字/示意性轮廓/不得精确还原”发生冲突时，以商品真实外观为准：保留参考件中真实可见的涂装、色块分区、品牌字标、车身号码与既有赞助标识；只禁止新增参考中不存在的字幕、价格、海报文字、水印、号码或品牌标识。";

export interface ProductAppearancePriorityPolicy {
  version: typeof PRODUCT_APPEARANCE_PRIORITY_VERSION;
  conflictPriority: "real-product-reference-over-generic-redaction";
  appearanceMode: "reference-faithful";
  exactAppearanceRequired: true;
  preserveFromReference: readonly string[];
  forbidOnlyWhenNotInReference: readonly string[];
}

export const PRODUCT_APPEARANCE_PRIORITY_POLICY: ProductAppearancePriorityPolicy = Object.freeze({
  version: PRODUCT_APPEARANCE_PRIORITY_VERSION,
  conflictPriority: "real-product-reference-over-generic-redaction",
  appearanceMode: "reference-faithful",
  exactAppearanceRequired: true,
  preserveFromReference: ["涂装", "色块分区", "品牌字标", "车身号码", "既有赞助标识"],
  forbidOnlyWhenNotInReference: ["字幕", "价格", "海报文字", "水印", "新增号码", "新增品牌标识"],
});

export interface ProductAppearanceReconcileResult {
  prompt: string;
  applied: boolean;
  replacements: string[];
  version: typeof PRODUCT_APPEARANCE_PRIORITY_VERSION;
}

interface Replacement {
  id: string;
  pattern: RegExp;
  value: string;
}

const REPLACEMENTS: readonly Replacement[] = [
  {
    id: "preserve-real-livery-and-marks",
    pattern: /车身与整流罩不出现分色赛车涂装、贴花、赞助商标识与任何可读字标/g,
    value: "车身与整流罩保留本次绑定商品参考中真实可见的涂装、贴花、品牌字标、车身号码与既有赞助标识",
  },
  {
    id: "preserve-reference-source-paint",
    pattern: /本片不复制来源涂装[^。；\n]*/g,
    value: "本片保留本次绑定商品参考中真实可见的涂装、贴花与既有可读标识",
  },
  {
    id: "real-product-over-conceptual-silhouette",
    pattern: /商品外观仅作权利安全示意/g,
    value: "商品外观以本次绑定真实商品参考为准",
  },
  {
    id: "real-product-over-non-exact-rendering",
    pattern: /不宣称精确还原官方(?:车型|外观)/g,
    value: "按本次绑定商品参考真实呈现可见外观",
  },
  {
    id: "real-product-over-generic-outline",
    pattern: /示意性整车轮廓/g,
    value: "真实商品整车外观",
  },
  {
    id: "allow-existing-reference-marks",
    pattern: /不得输出参考中的海报文字、价格、赞助商文字与可读logo/gi,
    value: "保留参考件车身中真实可见的既有品牌字标、号码与赞助标识；不得复制海报文字、价格页或新增参考中不存在的标识",
  },
  {
    id: "split-generated-overlays-from-product-marks",
    pattern: /生成画面内无任何生成文字、字幕、标题卡、logo、水印与可读数字/g,
    value: "除商品参考中真实可见的车身字标、号码与赞助标识外，不新增生成文字、字幕、标题卡、水印或数字",
  },
  {
    id: "split-generated-overlays-from-product-marks-en",
    pattern: /no\s+text\/caption\/logo\/watermark\/readable\s+characters\/UI\s+text/gi,
    value: "除商品参考中真实可见的车身字标与号码外，不新增文字、字幕、水印或界面文字",
  },
];

/**
 * Reconcile only product-appearance clauses. General platform text safety is
 * retained and narrowed to "do not add text that is absent from the approved
 * product reference", rather than deleting real product identifiers.
 */
export function reconcileProductAppearancePrompt(prompt: string): ProductAppearanceReconcileResult {
  let next = String(prompt ?? "");
  const replacements: string[] = [];
  for (const replacement of REPLACEMENTS) {
    replacement.pattern.lastIndex = 0;
    if (replacement.pattern.test(next)) {
      replacement.pattern.lastIndex = 0;
      next = next.replace(replacement.pattern, replacement.value);
      replacements.push(replacement.id);
    }
  }
  if (!next.includes(PRODUCT_APPEARANCE_PRIORITY_CLAUSE)) {
    next = `${next.trimEnd()}\n${PRODUCT_APPEARANCE_PRIORITY_CLAUSE}`;
    replacements.push("append-priority-clause");
  }
  return {
    prompt: next,
    applied: replacements.length > 0,
    replacements,
    version: PRODUCT_APPEARANCE_PRIORITY_VERSION,
  };
}

export function isProductAppearanceRedactionPatch(clause: string): boolean {
  const value = String(clause ?? "");
  const removal = /删除|移除|去掉|不得|禁止|无|去掉|改写成|不复制|不出现/.test(value);
  const productSurface = /商品|商品参考|参考图|车身|涂装|贴花|赞助|字标|号码|logo|外观|整车/.test(value);
  const exactIdentity = /精确还原|真实外观|品牌字标|车身号码|既有标识|锁定外观/.test(value);
  return removal && productSurface && exactIdentity;
}
