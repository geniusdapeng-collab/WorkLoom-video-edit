/**
 * FoxGuide · 首日上岗引导 NPC「狐狸先生」
 *
 * 为什么是程序化 SVG：本仓的既有纪律是「零音频资产 / 零版权风险」（见 docs/tech-design-m1.md）。
 * 数字人形象沿用同一纪律——狐狸先生完全由 SVG + CSS 动画绘制，不引入任何图片、Live2D 或 3D 资产，
 * 因此不会与 `public/live2d`、`public/models` 的既有许可产生新的约束。
 *
 * 状态（由叙事驱动，不由业务猜测）：
 *  idle 待命 · listen 等客户操作 · talk 正在说话 · think 任务执行中 · celebrate 过关 · alert 需要人审/失败
 *
 * 降级：`prefers-reduced-motion` 下只保留最轻的呼吸动画；SVG 渲染失败也不影响任何业务按钮。
 */
import { useEffect, useRef, useState } from "react";

export type FoxMood = "idle" | "listen" | "talk" | "think" | "celebrate" | "alert";

export interface FoxGuideProps {
  /** 画布边长（px） */
  size?: number;
  mood?: FoxMood;
  /** 是否正在说话（驱动口型开合） */
  speaking?: boolean;
  className?: string;
  /** 无障碍标签；默认按状态生成 */
  label?: string;
}

const MOOD_LABEL: Record<FoxMood, string> = {
  idle: "待命",
  listen: "在听",
  talk: "正在汇报",
  think: "正在跟进",
  celebrate: "在庆祝",
  alert: "需要您拍板",
};

let styleInjected = false;

function useFoxStyle(): void {
  const [ready, setReady] = useState(styleInjected);
  const ref = useRef(false);
  useEffect(() => {
    if (styleInjected || ref.current) return;
    ref.current = true;
    styleInjected = true;
    setReady(true);
  }, []);
  // 首帧就渲染 <style>，避免动画晚一帧启动（SSR 场景下也是幂等的）
  void ready;
}

export function FoxGuide({
  size = 128,
  mood = "idle",
  speaking = false,
  className,
  label,
}: FoxGuideProps) {
  useFoxStyle();
  const activeMood: FoxMood = speaking && mood !== "celebrate" && mood !== "alert" ? "talk" : mood;
  const aria = label ?? `狐狸先生（${MOOD_LABEL[activeMood]}）`;

  return (
    <span
      className={className}
      data-fox-guide="true"
      data-fox-mood={activeMood}
      style={{ display: "inline-block", width: size, height: size, lineHeight: 0 }}
    >
      <style>{FOX_CSS}</style>
      <svg
        viewBox="0 0 200 200"
        width={size}
        height={size}
        role="img"
        aria-label={aria}
        className={`fox-root fox-${activeMood}`}
      >
        <defs>
          <linearGradient id="fox-fur" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f9a03f" />
            <stop offset="100%" stopColor="#e2701a" />
          </linearGradient>
          <linearGradient id="fox-fur-dark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e2701a" />
            <stop offset="100%" stopColor="#c25512" />
          </linearGradient>
          <radialGradient id="fox-halo" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stopColor="#ffd98a" stopOpacity="0" />
            <stop offset="78%" stopColor="#ffd98a" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* 说话/庆祝时的光环 */}
        <circle
          cx="100"
          cy="112"
          r="86"
          fill="url(#fox-halo)"
          className="fox-halo"
          opacity={activeMood === "talk" || activeMood === "celebrate" ? 1 : 0.35}
        />

        <g className="fox-stage">
          {/* 尾巴（先画，压在身体后面） */}
          <g className="fox-tail">
            <path
              d="M136 176 C 162 184 184 170 190 142"
              fill="none"
              stroke="url(#fox-fur-dark)"
              strokeWidth="22"
              strokeLinecap="round"
              opacity="0.95"
            />
            <path
              d="M172 160 C 188 150 196 134 194 116"
              fill="none"
              stroke="url(#fox-fur-dark)"
              strokeWidth="15"
              strokeLinecap="round"
              opacity="0.95"
            />
            <circle cx="195" cy="110" r="10" fill="#fff4e6" />
          </g>

          {/* 身体 */}
          <g className="fox-body">
            <path d="M58 200 C 58 156 74 138 100 138 C 126 138 142 156 142 200 Z" fill="url(#fox-fur)" />
            <path d="M84 200 C 84 166 92 150 100 150 C 108 150 116 166 116 200 Z" fill="#fff7ee" opacity="0.95" />
          </g>

          {/* 头 + 耳 */}
          <g className="fox-head">
            <g className="fox-ear-l">
              <path d="M62 66 L 54 18 L 92 48 Z" fill="url(#fox-fur-dark)" />
              <path d="M68 62 L 64 32 L 86 50 Z" fill="#3a2016" opacity="0.75" />
            </g>
            <g className="fox-ear-r">
              <path d="M138 66 L 146 18 L 108 48 Z" fill="url(#fox-fur-dark)" />
              <path d="M132 62 L 136 32 L 114 50 Z" fill="#3a2016" opacity="0.75" />
            </g>
            <path
              d="M56 86 C 56 54 76 38 100 38 C 124 38 144 54 144 86 C 144 118 126 134 100 134 C 74 134 56 118 56 86 Z"
              fill="url(#fox-fur)"
            />
            {/* 面部白色区 */}
            <path
              d="M100 76 C 118 76 132 90 132 104 C 132 122 117 134 100 134 C 83 134 68 122 68 104 C 68 90 82 76 100 76 Z"
              fill="#fff7ee"
            />

            {/* 眼睛 */}
            <g className="fox-eyes">
              <ellipse cx="82" cy="92" rx="7" ry="8" fill="#33231c" />
              <ellipse cx="118" cy="92" rx="7" ry="8" fill="#33231c" />
              <circle cx="84.4" cy="89" r="2.4" fill="#ffffff" opacity="0.92" />
              <circle cx="120.4" cy="89" r="2.4" fill="#ffffff" opacity="0.92" />
            </g>
            {/* 眨眼用的眼睑：与眼睛同形，常态透明，动画里瞬间落下 */}
            <g className="fox-lids">
              <ellipse cx="82" cy="92" rx="8.4" ry="9" fill="#f0913a" />
              <ellipse cx="118" cy="92" rx="8.4" ry="9" fill="#f0913a" />
            </g>

            {/* 鼻与嘴 */}
            <path d="M94 106 Q 100 102 106 106 Q 100 114 94 106 Z" fill="#3a2016" />
            <path
              className="fox-mouth"
              d="M100 114 C 96 122 88 124 84 120"
              fill="none"
              stroke="#3a2016"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
            {/* 说话时的第二段口型（与上一段交替，形成开合） */}
            <path
              className="fox-mouth-open"
              d="M100 114 C 97 126 90 128 86 124"
              fill="none"
              stroke="#3a2016"
              strokeWidth="2.6"
              strokeLinecap="round"
            />

            {/* 腮红 */}
            <ellipse cx="74" cy="108" rx="7" ry="4.4" fill="#ff9b8a" opacity="0.5" />
            <ellipse cx="126" cy="108" rx="7" ry="4.4" fill="#ff9b8a" opacity="0.5" />
          </g>

          {/* 情绪挂件：庆祝星星 / 待判感叹号 / 思考点 */}
          <g className="fox-badge fox-stars" opacity="0">
            <path d="M40 58 l4 9 9 4 -9 4 -4 9 -4 -9 -9 -4 9 -4 z" fill="#ffd98a" />
            <path d="M162 52 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z" fill="#ffe9b8" />
            <path d="M150 88 l2.4 5.4 5.4 2.4 -5.4 2.4 -2.4 5.4 -2.4 -5.4 -5.4 -2.4 5.4 -2.4 z" fill="#ffd98a" />
          </g>
          <g className="fox-badge fox-alert-mark" opacity="0">
            <circle cx="160" cy="60" r="15" fill="#ffbe6a" opacity="0.18" />
            <path d="M160 50 v11" stroke="#ffbe6a" strokeWidth="4" strokeLinecap="round" />
            <circle cx="160" cy="68" r="2.6" fill="#ffbe6a" />
          </g>
          <g className="fox-badge fox-dots" opacity="0">
            <circle cx="150" cy="60" r="4" fill="#8ad8ff" className="fox-dot fox-dot-1" />
            <circle cx="164" cy="60" r="4" fill="#8ad8ff" className="fox-dot fox-dot-2" />
            <circle cx="178" cy="60" r="4" fill="#8ad8ff" className="fox-dot fox-dot-3" />
          </g>
        </g>
      </svg>
    </span>
  );
}

/** 组件内联样式：类名统一 `fox-` 前缀，避免污染全局 */
const FOX_CSS = `
.fox-root { overflow: visible; }
.fox-stage { transform-origin: 100px 200px; animation: fox-breathe 3.4s ease-in-out infinite; }
.fox-tail { transform-origin: 140px 168px; animation: fox-tail 2.6s ease-in-out infinite; }
.fox-head { transform-origin: 100px 120px; }
.fox-eyes, .fox-lids { transform-origin: 100px 92px; }
.fox-lids { animation: fox-blink 5.2s infinite; }
.fox-mouth-open { opacity: 0; }

@keyframes fox-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
@keyframes fox-tail { 0%,100% { transform: rotate(-7deg); } 50% { transform: rotate(7deg); } }
@keyframes fox-blink { 0%,93%,100% { transform: scaleY(0); } 95%,97% { transform: scaleY(1); } }
@keyframes fox-jump { 0%,100% { transform: translateY(0); } 30% { transform: translateY(-14px); } 55% { transform: translateY(0); } 75% { transform: translateY(-6px); } }
@keyframes fox-mouth-a { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes fox-mouth-b { 0%,100% { opacity: 0; } 50% { opacity: 1; } }
@keyframes fox-star-pop { 0% { opacity: 0; transform: scale(.6); } 40% { opacity: 1; transform: scale(1.15); } 100% { opacity: 0; transform: scale(.9) translateY(-8px); } }
@keyframes fox-dot { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
@keyframes fox-halo-pulse { 0%,100% { opacity: .35; } 50% { opacity: .8; } }

/* 说话：口型开合 + 头部微动 */
.fox-talk .fox-tail { animation-duration: 1.5s; }
.fox-talk .fox-mouth { animation: fox-mouth-a .3s steps(2) infinite; }
.fox-talk .fox-mouth-open { animation: fox-mouth-b .3s steps(2) infinite; }
.fox-talk .fox-halo { animation: fox-halo-pulse 1.8s ease-in-out infinite; }
.fox-talk .fox-head { animation: fox-nod 1.6s ease-in-out infinite; }
@keyframes fox-nod { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-1.4deg); } }

/* 聆听：耳朵立起，轻微点头 */
.fox-listen .fox-ear-l { animation: fox-ear-listen .9s ease-in-out infinite; transform-origin: 74px 56px; }
.fox-listen .fox-ear-r { animation: fox-ear-listen .9s ease-in-out infinite .12s; transform-origin: 126px 56px; }
@keyframes fox-ear-listen { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-3deg); } }

/* 思考：点点闪烁 */
.fox-think .fox-dots { opacity: 1; }
.fox-think .fox-dot-1 { animation: fox-dot 1.2s infinite 0s; }
.fox-think .fox-dot-2 { animation: fox-dot 1.2s infinite .18s; }
.fox-think .fox-dot-3 { animation: fox-dot 1.2s infinite .36s; }

/* 庆祝：起跳 + 星星 */
.fox-celebrate .fox-stage { animation: fox-jump .9s ease-in-out 2; }
.fox-celebrate .fox-stars { opacity: 1; animation: fox-star-pop 1.4s ease-out 1; }
.fox-celebrate .fox-tail { animation-duration: .9s; }

/* 待判/异常：耳朵后压 + 感叹号 */
.fox-alert .fox-alert-mark { opacity: 1; }
.fox-alert .fox-ear-l { transform: rotate(-14deg) translateY(3px); transform-origin: 74px 56px; }
.fox-alert .fox-ear-r { transform: rotate(14deg) translateY(3px); transform-origin: 126px 56px; }
.fox-alert .fox-stage { animation-duration: 2.2s; }

@media (prefers-reduced-motion: reduce) {
  .fox-root .fox-stage,
  .fox-root .fox-tail,
  .fox-root .fox-lids,
  .fox-root .fox-head,
  .fox-root .fox-mouth,
  .fox-root .fox-mouth-open,
  .fox-root .fox-ear-l,
  .fox-root .fox-ear-r,
  .fox-root .fox-halo,
  .fox-root .fox-dot,
  .fox-root .fox-stars { animation: none !important; }
  .fox-talk .fox-mouth-open { opacity: 0; }
}
`;
