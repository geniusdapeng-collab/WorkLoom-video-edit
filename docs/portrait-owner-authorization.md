# 记录角色资产的所有者决定

`portrait-agent accept` 支持两种真实依据。两者都使用 `via=owner-acceptance`，机器评审只作留证。记录前必须已经有对应的所有者决定；命令和回执本身不创造新的许可。

默认 `--basis human-visual-review` 保留旧命令语义：`--by` 所列的人已看过原图，`--note` 记录视觉验收依据。存储仍是 `basis=human-review`，旧门账本和后续人类否决继续有效。

已有用途授权由代理代录时使用 `--basis explicit-owner-authorization`。例如所有者已明确要求把一组新 AI 角色设为默认角色并用于指定影片，可以直接忠实记录该既有决定，不重复索要批准，也不声称所有者逐图看过：

```sh
HR_CHARACTER_LIBRARY=/absolute/path/to/characters node --import tsx scripts/tools/portrait-agent.mts accept \
  --character model-directory --version 1 \
  --basis explicit-owner-authorization \
  --by "产品所有者" --recorded-by "Codex" \
  --note "此处填写本会话已给出的用途原话或准确依据，不得编造批准。" \
  --anchor /absolute/path/to/characters/model-directory/portraits/v1/current-front.png
```

新模式分别保存产品所有者 `decisionOwner`、执行代理 `recordedBy`、既有用途依据 `statement`、角色 profile ID 和版本。`--anchor` 必须显式等于该版本当前 `front`；不使用旧真人照片或 `sources/` 回退。当前版本每个声明角度都保存相对路径与完整 SHA256，包括四个核心角度以外的图。八角度版本因此绑定全部八张。此模式不接受 `--with-likeness`，不加载模型密钥，不调用付费模型，也不声称新 AI 图是认证真人事实锚。

所有者回执位于角色 `reviews/`。门事件保存相同授权合同及回执完整 SHA256。G5 消费时重读角色的显式激活版本，校验回执普通文件、完整 SHA、合同一致性、新 AI front 和全部声明角度当前字节，以及实际用于出片的路径。缺件、篡改、版本变化、未知 basis、机器伪装来源和重定向 symlink 均不授予放行；损坏的新授权不会回退早先批准。合法的后续同版本所有者否决仍阻断，后续机器记录不能覆盖所有者决定。

旧 `human-review` 回执按原有四核心角度消费，保持已有记录兼容。纯机器留证不能授予本地角色的生产放行。授权与否决事件均使用 profile 的角色 ID；CLI `--character` 是目录组件，两者可以不同。

该合同证明所记录的决定、资产版本与当前字节相互对应。它不提供供应商认证、身份鉴定或对会话原话的外部签名；能改写整个本地账本与回执的人仍处于系统的写权限信任边界内。
