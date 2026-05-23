/** Synthia logo mark (transparent PNG, no container fill). */

export function BrandMark({ size = 36, fill = false }: { size?: number; fill?: boolean }) {
  return (
    <span
      className={`brand-mark${fill ? ' brand-mark--fill' : ''}`}
      style={fill ? undefined : { width: size, height: size }}
      aria-hidden
    >
      <img src="/synthia-logo.png" alt="" className="brand-mark-img" draggable={false} />
    </span>
  )
}
