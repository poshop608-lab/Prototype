import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-sv-gray-700 text-sv-gray-100",
        secondary: "bg-sv-gray-700 text-sv-gray-300",
        success: "bg-sv-green/20 text-sv-green border border-sv-green/30",
        warning: "bg-amber-500/20 text-amber-400 border border-amber-500/30",
        destructive: "bg-sv-red/20 text-sv-red border border-sv-red/30",
        outline: "border border-sv-gray-600 text-sv-gray-300",
        processing: "bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
