/**
 * MateGuideBubble · 织伴（首席增长官）的对话气泡
 *
 * - 打字机呈现，点击气泡可立即显示全文（客户永远能"跳过废话"）；
 * - 同步走 VoiceEngine（role=mate-guide + 织伴音色档案，与欢迎仪式同源），
 *   语音不可用时自动只走字幕条；
 * - 气泡只负责"说话"，不做任何业务判断。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { VoiceEngine, type VoicePriority } from "../../voice/VoiceEngine";
import { MATE_VOICE_PROFILE } from "../../voice/mateVoice";
import { useQuestlineContent } from "../../onboarding/QuestlineContent";

const CHAR_MS = 22;

export interface MateGuideBubbleProps {
  text: string;
  voice?: boolean;
  priority?: VoicePriority;
  /** 视觉强调：默认/金色（过关）/警示（需人审） */
  tone?: "default" | "gold" | "warn";
  className?: string;
  /** 气泡下方的操作区（按钮等） */
  children?: ReactNode;
}

const TONE: Record<NonNullable<MateGuideBubbleProps["tone"]>, string> = {
  default: "border-line bg-card",
  gold: "border-gold/60 bg-gold/10",
  warn: "border-amber-400/60 bg-amber-400/10",
};

export function MateGuideBubble({
  text,
  voice = true,
  priority = "ceremony",
  tone = "default",
  className,
  children,
}: MateGuideBubbleProps) {
  const [shown, setShown] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const saidRef = useRef("");
  const fallbackRef = useRef<number | null>(null);
  const content = useQuestlineContent();

  /* m5：口型跟真实 TTS 走——订阅 VoiceEngine 的口型事件（start/boundary/end），
     说话结束立即闭嘴；无语音降级时由上方的估算计时兜底。 */
  useEffect(() => {
    const off = VoiceEngine.onLipSync((ev) => {
      if (ev.role !== "mate-guide") return;
      if (ev.type === "end") {
        setSpeaking(false);
        if (fallbackRef.current !== null) {
          window.clearTimeout(fallbackRef.current);
          fallbackRef.current = null;
        }
      } else {
        setSpeaking(true);
      }
    });
    return () => {
      off();
      if (fallbackRef.current !== null) window.clearTimeout(fallbackRef.current);
    };
  }, []);

  /* 打字机 */
  useEffect(() => {
    setShown(0);
    if (!text) return;
    const timer = window.setInterval(() => {
      setShown((n) => {
        if (n >= text.length) {
          window.clearInterval(timer);
          return n;
        }
        return n + 1;
      });
    }, CHAR_MS);
    return () => window.clearInterval(timer);
  }, [text]);

  /* 语音：同一句只播一次（防止 React 重渲染重复开口） */
  useEffect(() => {
    if (!voice || !text.trim()) return;
    if (saidRef.current === text) return;
    saidRef.current = text;
    setSpeaking(true);
    // 估算时长只作兜底：真实 TTS 可用时由 onLipSync 的 end 事件提前收口
    fallbackRef.current = window.setTimeout(() => {
      setSpeaking(false);
      fallbackRef.current = null;
    }, Math.max(1600, text.length * 190));
    try {
      VoiceEngine.speak({
        role: "mate-guide",
        persona: `${content.mateName} · ${content.mateRole}`,
        text,
        priority,
        voiceOverride: MATE_VOICE_PROFILE,
      });
    } catch {
      /* 语音失败只影响"听"，不影响"看" */
    }
    return () => {
      if (fallbackRef.current !== null) {
        window.clearTimeout(fallbackRef.current);
        fallbackRef.current = null;
      }
    };
  }, [text, voice, priority, content]);

  const done = shown >= text.length;

  return (
    <div className={`relative min-w-0 ${className ?? ""}`}>
      {/* 指向织伴的小尖角 */}
      <span
        aria-hidden="true"
        className={`absolute -top-2 right-8 h-3 w-3 rotate-45 border-l border-t ${TONE[tone]}`}
      />
      <div
        // 窄屏限高：气泡本身可滚动，避免台词把员工卡整片遮住（移动端实测占屏 28%）
        className={`min-w-0 max-h-[38vh] overflow-y-auto rounded-2xl border px-4 py-3 shadow-lg backdrop-blur ${TONE[tone]}`}
        onClick={() => setShown(text.length)}
        data-mate-bubble="true"
        data-mate-speaking={speaking ? "true" : "false"}
      >
        <div className="mb-1 flex items-center gap-2 text-body text-ink3">
          <span className="font-bold text-goldhi">{content.mateName}</span>
          <span className="text-ink3">{content.mateRole}</span>
          {!done && <span className="ml-auto text-ink3">点击可跳过</span>}
        </div>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink">
          {text.slice(0, shown)}
          {!done && <span className="ml-0.5 animate-pulse text-gold">▌</span>}
        </p>
        {children && <div className="mt-3 min-w-0">{children}</div>}
      </div>
    </div>
  );
}
