import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export { default as Tabs } from "./Tabs.vue"
export { default as TabsContent } from "./TabsContent.vue"
export { default as TabsList } from "./TabsList.vue"
export { default as TabsTrigger } from "./TabsTrigger.vue"

export const tabsListVariants = cva(
  "inline-flex items-center",
  {
    variants: {
      variant: {
        default: "h-9 w-fit justify-center rounded-lg bg-muted p-0.75 text-muted-foreground",
        line: "flex h-auto w-full justify-start gap-1 rounded-none border-b border-line bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type TabsListVariants = VariantProps<typeof tabsListVariants>

export const tabsTriggerVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring focus-visible:ring-3 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "h-[calc(100%-1px)] flex-1 rounded-md border border-transparent px-2 py-1 text-sm font-medium text-foreground dark:text-muted-foreground data-[state=active]:bg-background data-[state=active]:shadow-sm dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        line: "inline-block h-auto flex-none rounded-none border-0 border-b-2 border-b-transparent bg-transparent px-2 py-2 text-xs font-normal text-fg-secondary hover:text-fg data-[state=active]:border-b-brand data-[state=active]:text-fg",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)
export type TabsTriggerVariants = VariantProps<typeof tabsTriggerVariants>
