import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import { clsx } from 'clsx'

export function Button({ className, children, ...props }: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>) {
  return <button className={clsx('btn', className)} {...props}>{children}</button>
}
