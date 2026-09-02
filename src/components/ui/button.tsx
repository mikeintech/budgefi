import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const variants = cva('inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] px-4 text-[15px] font-semibold transition-[transform,background-color,color,border-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:pointer-events-none disabled:opacity-45 active:translate-y-px', {
  variants: { variant: {
    default: 'bg-pencil text-white shadow-[0_2px_0_rgb(27_45_120/.24)] hover:bg-[#284ab4]',
    secondary: 'border border-rule bg-sheet text-carbon hover:bg-recessed',
    ghost: 'text-pencil hover:bg-pencil/8',
    outline: 'border border-rule bg-sheet text-carbon hover:bg-recessed',
    destructive: 'bg-coral text-white hover:bg-[#873025]',
  }, size: { default: 'h-12', sm: 'min-h-11 px-3 text-sm', lg: 'min-h-14 px-5 text-[15px]', icon: 'size-12 p-0' } }, defaultVariants: { variant: 'default', size: 'default' }
})
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild=false, ...props }, ref) => { const Comp=asChild?Slot:'button'; return <Comp className={cn(variants({variant,size}),className)} ref={ref} {...props}/> })
Button.displayName='Button'
