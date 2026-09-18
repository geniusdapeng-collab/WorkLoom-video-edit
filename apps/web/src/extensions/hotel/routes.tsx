/**
 * 酒店获客控制台（行业扩展路由）。
 *
 * 这些页面是**获客闭环的经营台**，不是酒店后台：意图洞察 → 双域触达 → 四路承接 → 线索转化 → 归因复盘。
 * legacyPaths 保留行业包 ui/cases.json 里的历史页号（p10–p20），旧链接重定向到新路由。
 */
import Breakpoints from "./pages/Breakpoints";
import Channels from "./pages/Channels";
import Fleet from "./pages/Fleet";
import Goals from "./pages/Goals";
import Housekeeping from "./pages/Housekeeping";
import OrderFlow from "./pages/OrderFlow";
import PriceHealth from "./pages/PriceHealth";
import ProfileOverview from "./pages/ProfileOverview";
import ReviewSla from "./pages/ReviewSla";
import Revenue from "./pages/Revenue";
import ServiceFront from "./pages/ServiceFront";

export const industryRoutes = [
  /**
   * 注意：/p10 历史页号已被 ai-video 扩展（素材库）占用，注册表要求历史地址全局唯一。
   * 断点流页面保留在新路由 /hotel/breakpoints，不再声明 /p10，避免整个扩展注册表 fail closed。
   */
  { path: "/hotel/breakpoints", capabilityId: "hotel.breakpoints", element: <Breakpoints /> },
  { path: "/hotel/price-health", capabilityId: "hotel.price-health", element: <PriceHealth />, legacyPaths: ["/p11"] },
  { path: "/hotel/goals", capabilityId: "hotel.goals", element: <Goals />, legacyPaths: ["/p12"] },
  { path: "/hotel/order-flow", capabilityId: "hotel.order-flow", element: <OrderFlow />, legacyPaths: ["/p13"] },
  { path: "/hotel/channels", capabilityId: "hotel.channels", element: <Channels />, legacyPaths: ["/p14"] },
  { path: "/hotel/review-sla", capabilityId: "hotel.review-sla", element: <ReviewSla />, legacyPaths: ["/p15"] },
  { path: "/hotel/service-front", capabilityId: "hotel.service-front", element: <ServiceFront />, legacyPaths: ["/p16"] },
  { path: "/hotel/housekeeping", capabilityId: "hotel.housekeeping", element: <Housekeeping />, legacyPaths: ["/p17"] },
  { path: "/hotel/fleet", capabilityId: "hotel.fleet", element: <Fleet />, legacyPaths: ["/p18"] },
  { path: "/hotel/revenue", capabilityId: "hotel.revenue", element: <Revenue />, legacyPaths: ["/p19"] },
  { path: "/hotel/profile", capabilityId: "hotel.profile", element: <ProfileOverview />, legacyPaths: ["/p20"] },
] as const;
