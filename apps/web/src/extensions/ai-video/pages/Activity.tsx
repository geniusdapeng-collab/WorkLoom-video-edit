import { Bridge } from "../../../shell/Bridge";
import { PageExitLink } from "../../../shell/PageExitLink";
import { LiveTicker } from "../components/activity/LiveTicker";

export default function Activity() {
  return <Bridge><PageExitLink label="返回工作台" /><h2 className="mt-3 break-words text-h1 font-black text-ink">视频经营动态</h2><p className="mt-1 break-words text-caption text-ink3">动态仅在视频行业页内展示，不占用全局顶栏。</p><div className="mt-4 rounded-lg border border-line bg-card p-4"><LiveTicker /></div></Bridge>;
}
