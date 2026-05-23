/** Synthia logo mark (transparent PNG, no container fill). */

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="brand-mark"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img src="/synthia-logo.png" alt="" className="brand-mark-img" draggable={false} />
    </span>
  )
}
