"use strict";

/** Follow the real guide lifecycle within the existing render smoke deadline. */
async function dismissFirstDayGuide(probe, {
  timeoutMs = 10000,
  now = Date.now,
  pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  let shown = false;
  let clicked = false;
  let supported = false;
  let clearSince = null;
  while (now() < deadline) {
    const state = await probe();
    if (!state || [state.shown, state.clicked, state.supported].some((value) => typeof value !== "boolean")) {
      throw new Error("首日上岗引导探针返回非法状态");
    }
    supported ||= state.supported;
    shown ||= state.shown;
    clicked ||= state.clicked;
    if (state.shown) {
      if (!state.clicked) throw new Error("首日上岗引导缺少可用退出按钮");
      clearSince = null;
    } else if (!supported || shown) {
      clearSince ??= now();
      // 等 React 的后续提交稳定，不能以 welcome/guide 两层之间的空帧判定退出。
      if (now() - clearSince >= 750) return { shown, clicked, supported, closed: true };
    }
    await pause(250);
  }
  return { shown, clicked, supported, closed: false };
}

module.exports = { dismissFirstDayGuide };
