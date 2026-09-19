/**
 * collaboration —— 协作底座纯逻辑（对象读模型/任务契约/交接回执/决策配额/组合叙事）
 * 纪律：本包不碰 HTTP / DB；DB 读写在 apps/server/src/service/collaboration.ts。
 */
export * from "./schema.js";
export * from "./contract.js";
export * from "./quota.js";
export * from "./portfolio.js";
