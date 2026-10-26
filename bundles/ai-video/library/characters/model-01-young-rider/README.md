# 1号原创虚构AI人物：李英子

`young-rider-01` 是本任务从纯文字开始重新生成的成年虚构女性人物：约20岁、鹅蛋脸、黑色高马尾，黑色机车夹克、白T、深色长裤与黑靴。未显式指定模特时按registry选用；陈卓与林予安仍可按姓名显式选用。

李英子，朋友们都叫她英子，是20岁的工业设计专业大二学生。她喜欢攀岩、滑板和机车文化，也会画草图、拍运动视频，琢磨一件装备为什么这样设计。她爽快好奇、有点好强，遇到陌生挑战也会紧张；先问清楚、做好准备，再用练习建立信心。分享发现时像和朋友聊天，说具体细节，也愿意承认自己还不知道什么。校园、专业、爱好和经历都是虚构创作设定，不对应任何真实学校、赛事成绩或运动资质。

本轮实际共11次纯文字POST，最终选用8张，另3张背面候选因服装/姿态不合要求未选；未选原图与原始来源在任务私有staging原样保留，输出SHA与排除记录见v2来源，不能把选中8张说成总共只生成8次。

当前激活为逻辑v2：八张分别由真实Seedream纯文字请求生成的2K PNG原件，八次请求均没有图片或参考图输入。front / threeQuarter / closeup / side / back / actionPose / emotionCloseup / handDetail。

- `profile.json`：角色身份/persona/服装保持，当前唯一active为v2；`kind: generated`，`subjectType: synthetic-digital-human`，`authorization.status: synthetic-no-real-person`。
- `portrait-sets/v2.json`：相对路径、服装与精确八角度声明；`portraits/v2/*.png`保留供应商原始字节。
- `provenance/v2.json`：每张实际model/created/安全trace、纯文字请求/提示词SHA、输出PNG尺寸/字节数/SHA-256。`provenance/v2/`内逐张dispatch与来源收据按原字节保留。未返回的provider task_id为null，未编造seed或供应商签名。
- `portraits/v1`、`portrait-sets/v1.json`、原`provenance.json`和历史审批保留：v1是image_gen正面纯文字、其余7张仅参考本次新AI正面主图；没有改写成Seedream。显式pin v1仍可读取。

所有图片不缩放、不裁切、不重编码、不修脸、不改背景。采用可移植旧兼容结构，运行时scope为`legacy-current-bytes-only`；原图与来源metadata进入bundle完整性索引。视觉审阅仅说明本任务所见的成年虚构人物、角度与造型连续性，不是生物识别或人工审批；请求watermark=true如实留痕，隐式水印仍未验证。
