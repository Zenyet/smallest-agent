import icon from '../../../../build/icon.svg'

/** One vector source shared with the Dock, installer, and application UI. */
export function BrandMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img src={icon} width={size} height={size} alt="" aria-hidden className={`shrink-0 ${className}`} draggable={false} />
}
