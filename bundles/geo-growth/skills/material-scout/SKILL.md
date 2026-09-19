---
name: material-scout
version: 1.0.0
description: 素材寻源工艺：客户没有图时，从全球免费/开源图库检索合规素材（免 key 通道优先），核对授权与署名、下载入库并产出候选清单。
---

# 素材寻源（Material Scout）

## 触发
- brief 里 `assets_available` 为空或不足（客户无实拍图、只有文字）；
- 需要背景/场景/纹理/历史影像/插画等非产品素材；
- 需要为同一版式准备 3 个候选方向时。

## 图库策略（详见 `compositor-kit/templates/stock-sources.json`）

| 优先级 | 来源 | 授权 | 检索方式 |
|---|---|---|---|
| 1 | 客户实拍/视频抽帧 | 客户授权 | 本地素材库 |
| 2 | Wikimedia Commons / Openverse / The Met | CC0/PD 无义务；CC-BY 需署名 | **免 key API**（`visualread.search_stock`） |
| 3 | Unsplash / Pexels | 免费商用、无需署名 | CDN 已知 ID 直连；官方 API 可选 key |
| 4 | Pixabay / Smithsonian / NYPL / Europeana / Flickr Commons | 免费商用/公共领域（逐图核对） | 需免费 key；配置后可用 |
| 5 | StockSnap / Burst / Kaboompics / Rawpixel / unDraw / Openclipart | CC0 / 免费商用 | 站点检索（curated），人工挑选后 `fetch_stock` |

## 方法
1. **先搜后挑**：`visualread.search_stock` 用英文关键词（如 `pour over coffee barista`），`limit 8-12`，记录每个候选的 `license/attribution/source_page/尺寸`；
2. **筛选标准**：长边 ≥1600px、无平台水印、无文字水印、无未授权可识别人像、风格匹配 art-direction；
3. **授权核对**：CC0/PD 直接可用；CC-BY/CC-BY-SA 必须在成品或档案保留署名与来源页；
4. **入库**：`visualwrite.fetch_stock` 下载到租户 `assets/`，自动生成 `.license.json`（含 sha256、来源、授权、署名）；
5. **候选清单**：输出 `{candidates:[{id,url,license,attribution,score,notes}]}`，供设计岗位/客户选择；每次至少 3 个候选、2 个可用。

## 输出契约
- 候选清单 JSON + 已入库素材 + license sidecar；被拒候选写明原因（分辨率/水印/风格/授权）。

## 边界
- 不抓取禁止爬取的站点；不绕过反爬；不下载来源不明的图片；
- 不伪造来源、不删水印、不把 CC-BY 素材当 CC0 用；
- 图库解决"通用场景"，**产品本体仍应由客户实拍**——涉及产品细节时先向客户要图。
