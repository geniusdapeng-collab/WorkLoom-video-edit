/**
 * QuestlineContent · 首日上岗「内容包」注入点
 *
 * 背景：五关机制是基座的，员工卡/目标/任务卡是**行业内容**。同一次登录只可能处于
 * 一个活动 Bundle，而组件原先直接 import 酒店内容包，导致 GEO / ai-video 工作区里
 * 出现酒店岗位（张冠李戴）。
 *
 * 约定：由经营主页（P0）按当前 Bundle 解析内容包并注入；解析不到时不渲染引导，
 * 组件侧一律通过 useQuestlineContent() 取值，不得再直接 import QUESTLINE。
 */
import { createContext, useContext, type ReactNode } from "react";
import { QUESTLINE, type QuestlineConfig } from "./questline.config";

const QuestlineContentContext = createContext<QuestlineConfig>(QUESTLINE);

export function QuestlineContentProvider({
  content,
  children,
}: {
  content: QuestlineConfig;
  children: ReactNode;
}) {
  return <QuestlineContentContext.Provider value={content}>{children}</QuestlineContentContext.Provider>;
}

/** 取当前生效的内容包；未注入时退回酒店包（保证单测与旧调用点行为不变） */
export function useQuestlineContent(): QuestlineConfig {
  return useContext(QuestlineContentContext);
}
