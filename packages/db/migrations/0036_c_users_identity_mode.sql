-- C 端身份核验方式留痕（webc 契约 SessionUser.identityMode）。
-- 演示验证码与真实渠道核验不得混同：MePage 徽标（演示身份 / 入口已验证）与
-- 合规口径都以本列为准，不接受按登录开关临时推断。
ALTER TABLE c_users
  ADD COLUMN IF NOT EXISTS identity_mode TEXT NOT NULL DEFAULT 'demo'
    CHECK (identity_mode IN ('demo', 'verified'));

-- 历史行一律保持 'demo'：无法从旧数据反推真实核验方式，标成 verified 会是
-- 无依据的身份声明。重新走 /c/identity/bind 后由适配器的 demo 标记覆盖。
