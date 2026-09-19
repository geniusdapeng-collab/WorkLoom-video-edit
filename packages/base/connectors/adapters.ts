import { connectorFetch } from "./http.js";
import { ADS_GATEWAY, SOCIAL_DOUYIN } from "./registry.js";
import type { ConnectorContext } from "./types.js";

export interface CampaignMetric {
  campaignId: string;
  spendFen: number;
  impressions: number;
  clicks: number;
  conversions: number;
  roi: number;
}

export interface PostMetric {
  postId: string;
  title: string;
  plays: number;
  likes: number;
  comments: number;
  inquiries: number;
}

export interface PostComment {
  commentId: string;
  text: string;
  intent?: string;
  createdAt: string;
}

/** 广告投放数据（Meta / 千川 网关）：增量 ROI 与预算组合的事实来源。 */
export async function fetchCampaignMetrics(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ metrics: CampaignMetric[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    ADS_GATEWAY, `/metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { metrics?: CampaignMetric[] };
  return { metrics: body.metrics ?? [], attempts };
}

/** 内容数据（抖音开放平台）：选题与内容组合的事实来源。 */
export async function fetchPostMetrics(
  range: { from: string; to: string }, ctx?: ConnectorContext,
): Promise<{ posts: PostMetric[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    SOCIAL_DOUYIN, `/posts/metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`, {}, ctx,
  );
  const body = (await response.json()) as { posts?: PostMetric[] };
  return { posts: body.posts ?? [], attempts };
}

/** 评论拉取（四档分流的输入；分类仍由行业规则完成，连接器只取原文）。 */
export async function fetchPostComments(
  postId: string, ctx?: ConnectorContext,
): Promise<{ comments: PostComment[]; attempts: number }> {
  const { response, attempts } = await connectorFetch(
    SOCIAL_DOUYIN, `/posts/${encodeURIComponent(postId)}/comments`, {}, ctx,
  );
  const body = (await response.json()) as { comments?: PostComment[] };
  return { comments: body.comments ?? [], attempts };
}
