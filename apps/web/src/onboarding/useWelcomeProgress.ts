import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../lib/trpc";

export interface WelcomeState {
  status: "not_started" | "in_progress" | "paused" | "completed";
  currentStep: "start" | "mate" | "team" | "summary" | "done";
  journeyVersion: number;
  replayCount: number;
  shouldShow: boolean;
  persisted: boolean;
  role: string;
}

/** Only the current welcome action may update the page or release its overlay. */
export function useWelcomeProgress({ onVisibilityChange, onError }: {
  onVisibilityChange: (visible: boolean) => void;
  onError: (message: string) => void;
}) {
  const [welcome, setWelcome] = useState<WelcomeState | null>(null);
  const sequence = useRef(0);
  const terminalRequested = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onVisibilityChange, onError });
  callbacks.current = { onVisibilityChange, onError };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const initialize = useCallback((progress: WelcomeState) => {
    if (!mounted.current || sequence.current !== 0) return;
    setWelcome(progress);
    callbacks.current.onVisibilityChange(progress.shouldShow);
  }, []);

  const save = useCallback(async (
    status: "in_progress" | "paused" | "completed",
    currentStep: WelcomeState["currentStep"],
  ) => {
    if (!mounted.current || terminalRequested.current) return;
    const request = ++sequence.current;
    const terminal = status === "paused" || status === "completed";
    // The ceremony's still-running phase timer must not enqueue a new progress
    // request after the user has already chosen to leave it.
    if (terminal) {
      terminalRequested.current = true;
      // 用户选择跳过或稍后继续后，本地界面必须立即离开全屏仪式；
      // 网络持久化失败只影响下次启动是否重播，不能继续阻塞当前工作台。
      callbacks.current.onVisibilityChange(false);
    }
    try {
      const result = await trpc.onboarding.saveWelcomeProgress.mutate({ status, currentStep }) as Omit<WelcomeState, "role">;
      if (!mounted.current || request !== sequence.current) return;
      setWelcome(current => current ? { ...result, role: current.role } : null);
    } catch {
      if (!mounted.current || request !== sequence.current) return;
      terminalRequested.current = false;
      callbacks.current.onError("欢迎引导进度暂时无法保存，请稍后重试。");
    }
  }, []);

  return { welcome, initialize, save };
}
