import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
export const Accordion=AccordionPrimitive.Root
export function AccordionItem({className,...props}:React.ComponentProps<typeof AccordionPrimitive.Item>){return <AccordionPrimitive.Item className={cn('border-b border-rule',className)} {...props}/>}
export function AccordionTrigger({children,className,...props}:React.ComponentProps<typeof AccordionPrimitive.Trigger>){return <AccordionPrimitive.Header><AccordionPrimitive.Trigger className={cn('group flex min-h-12 w-full items-center justify-between gap-3 py-2 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pencil',className)} {...props}>{children}<ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"/></AccordionPrimitive.Trigger></AccordionPrimitive.Header>}
export function AccordionContent({children,className,...props}:React.ComponentProps<typeof AccordionPrimitive.Content>){return <AccordionPrimitive.Content className={cn('overflow-hidden text-sm data-[state=closed]:animate-[accordion-up_.15s_ease-out] data-[state=open]:animate-[accordion-down_.18s_ease-out]',className)} {...props}><div className="pb-4">{children}</div></AccordionPrimitive.Content>}
