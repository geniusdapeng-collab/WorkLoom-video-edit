/**
 * QuestlineHud · 首日上岗常驻入口（织伴 · 首席增长官待命位）
 *
 * 从欢迎仪式结束到五关走完，织伴一直待在经营主页左下角：
 *  - 未开始/进行中：显示"还差 N 关"，点一下继续；
 *  - 已完成：缩成小徽章，可重播，避免长期占屏。
 *
 * 2026-09-20（本机验收整改）：常驻卡片必须有「隐藏」出口——右上角 × 收起整卡，
 * 收起后同位置留一枚「织伴」小把手（点一下唤回），本机偏好写 localStorage；
 * 与 LoomMate 数字人浮层 `loommate.hidden` + 边缘把手同一交互口径，避免"关不掉"。
 */
import { useState } from "react";
import { storageKey } from "../../lib/product";
import type { QuestLevel, QuestProgressSummary } from "../../onboarding/questline";
import { useQuestlineContent } from "../../onboarding/QuestlineContent";
import { MateGuideAvatar } from "./MateGuideAvatar";

const HUD_HIDDEN_KEY = storageKey("questline.hud-hidden");

export interface QuestlineHudProps {
  summary: QuestProgressSummary;
  level: QuestLevel;
  xp: number;
  achievements: string[];
  /** 以服务端（团队页 roster）为准的累计 XP；缺省时退回本次会话 XP */
  serverXp?: number | null;
  /** 完成态：以 state.status 为准（跳过关卡不等于没完成） */
  completed: boolean;
  onOpen: () => void;
}

export function QuestlineHud({ summary, level, xp, achievements, serverXp, completed, onOpen }: QuestlineHudProps) {
  const content = useQuestlineContent();
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HUD_HIDDEN_KEY) === "1"; } catch { return false; }
  });
  const persistHidden = (next: boolean) => {
    setHidden(next);
    try { localStorage.setItem(HUD_HIDDEN_KEY, next ? "1" : "0"); } catch { /* 本机偏好不可写时不阻塞交互 */ }
  };
  // M1：XP 以服务端口径为主、本次会话为辅，避免同一屏出现两个"董事长等级"
  const totalXp = typeof serverXp === "number" ? serverXp : xp;
  const xpLabel = typeof serverXp === "number" ? "累计" : "本次";

  // 隐藏态：只留边缘小把手，点一下唤回（不占屏、不挡工作区）
  if (hidden) {
    return (
      <div
        className="pointer-events-none fixed bottom-24 left-2 z-30 sm:left-4"
        data-questline-hud="true"
        data-questline-hud-hidden="true"
      >
        <button
          type="button"
          onClick={() => persistHidden(false)}
          title="唤回织伴（首日上岗入口）"
          aria-label="唤回织伴（首日上岗入口）"
          className="pointer-events-auto flex min-h-10 items-center gap-1.5 rounded-full border border-gline/60 bg-panel/90 px-2.5 py-1 text-body text-ink2 shadow-lg backdrop-blur hover:border-gline hover:text-gold"
        >
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gold/15 text-gold">织</span>
          <span className="whitespace-nowrap">织伴</span>
        </button>
      </div>
    );
  }

  return (
    <div
      // S2：移动端同样要能进/继续首日上岗——窄屏用更紧凑的形态，不再整块隐藏
      className="pointer-events-none fixed bottom-24 left-2 z-30 block max-w-[calc(100vw-1rem)] sm:left-4"
      data-questline-hud="true"
      data-questline-complete={completed ? "true" : "false"}
    >
      <div className="pointer-events-auto flex min-w-0 items-end gap-2">
        <span className="hidden shrink-0 sm:inline-flex">
          <MateGuideAvatar size={64} mood={completed ? "celebrate" : "listen"} />
        </span>
        <span className="shrink-0 sm:hidden">
          <MateGuideAvatar size={44} mood={completed ? "celebrate" : "listen"} />
        </span>
        <div className="relative min-w-0 max-w-[15rem] rounded-2xl border border-gline/60 bg-panel/90 px-3 py-2 shadow-xl backdrop-blur">
          <button
            type="button"
            onClick={() => persistHidden(true)}
            title="隐藏织伴卡片（本机记住偏好，随时可唤回）"
            aria-label="隐藏织伴卡片"
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md border border-line/70 text-ink3 hover:border-gline hover:text-gold"
          >
            <span aria-hidden="true" className="text-body leading-none">✕</span>
          </button>
          <div className="flex min-w-0 items-center gap-2 pr-6">
            <span className="break-words text-body font-bold text-goldhi">{content.mateName}</span>
            <span className="text-body text-ink3">Lv.{level.level} {level.rank}</span>
          </div>
          <div className="mt-0.5 break-words text-body leading-relaxed text-ink2">
            {completed ? "首日上岗已完成，可以重播" : summary.label}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpen}
              className="min-h-8 rounded-lg border border-gline bg-gold/15 px-3 text-body font-bold text-gold hover:bg-gold/25"
            >
              {completed ? "重播首日上岗" : summary.done === 0 ? "开始首日上岗" : "继续首日上岗"}
            </button>
            <span className="font-mono text-body text-ink3">
              {xpLabel} {totalXp} XP{typeof serverXp === "number" && xp > 0 ? `（本次 +${xp}）` : ""}
            </span>
            <span className="text-body text-ink3">🏅{achievements.length}/{content.achievements.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
