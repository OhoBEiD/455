import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-3 py-0.5 text-xs font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-primary/30 bg-primary/20 text-primary',
        secondary: 'border-secondary/30 bg-secondary/20 text-secondary',
        success: 'border-secondary/30 bg-secondary/20 text-secondary',
        warning: 'border-yellow-400/30 bg-yellow-400/20 text-yellow-200',
        destructive: 'border-red-500/30 bg-red-500/20 text-red-300',
        muted: 'border-slate-600/50 bg-slate-700/50 text-slate-200',
        outline: 'border-slate-600/50 bg-transparent text-slate-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
)

Badge.displayName = 'Badge'
