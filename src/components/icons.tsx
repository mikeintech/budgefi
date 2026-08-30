import type { SVGProps } from 'react'
const base={fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round' as const,strokeLinejoin:'round' as const}
export type IconProps=SVGProps<SVGSVGElement>
export function TodayIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M5 6h14M5 18h14M12 8.5v7"/><circle cx="12" cy="12" r="3.25" fill="currentColor"/></svg>}
export function ReviewIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M7 4H3v16h4M17 4h4v16h-4M7 9h3M14 15h3"/><circle {...base} cx="12" cy="12" r="2.5"/></svg>}
export function PlanIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="m4 7 8-4 8 4-8 4-8-4Zm0 5 8 4 8-4M4 17l8 4 8-4"/></svg>}
export function ActivityIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M3 12h18M5 8v8M12 6v12M19 8v8"/><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>}
export function MoreIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><circle cx="7" cy="7" r="2" fill="currentColor"/><circle cx="17" cy="7" r="2" fill="currentColor"/><circle cx="7" cy="17" r="2" fill="currentColor"/><circle cx="17" cy="17" r="2" fill="currentColor"/></svg>}
export function ExpectedIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6"/></svg>}
export function ObservedIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><rect {...base} x="4" y="5" width="16" height="14" rx="2"/><path {...base} d="M4 9h16M8 13h8"/><circle cx="17" cy="16" r="2" fill="currentColor"/></svg>}
export function CandidateIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><circle {...base} cx="5" cy="12" r="3"/><circle {...base} cx="19" cy="12" r="3"/><path {...base} strokeDasharray="2 3" d="M8 12h8"/></svg>}
export function MissingSourceIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><rect {...base} x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3"/><path {...base} d="M8 12h6"/><circle cx="18" cy="18" r="2.5" fill="currentColor"/></svg>}
export function VerifiedIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="m12 2.5 2.1 1.9 2.9-.2.9 2.7 2.5 1.5-1.3 2.6.3 2.9-2.8.9-1.9 2.2-2.2-1.9-2.9.2-.9-2.7-2.5-1.5 1.3-2.6-.3-2.9 2.8-.9 1.9-2.2Z"/><path {...base} strokeWidth="2.8" d="m8.2 12 2.4 2.5 5.4-5.6"/></svg>}
export function WatchingIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>}
export function AllocationIcon(p:IconProps){return <svg viewBox="0 0 24 24" {...p}><path {...base} d="M4 6h16M4 12h12M4 18h8"/><circle cx="19" cy="18" r="2.5" fill="currentColor"/></svg>}
