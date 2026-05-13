import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-sv-white text-sv-black hover:bg-sv-gray-100 active:scale-[0.98]",
        destructive:
          "bg-sv-red text-white hover:bg-red-600 active:scale-[0.98]",
        outline:
          "border border-sv-gray-600 bg-transparent text-sv-white hover:bg-sv-gray-700 active:scale-[0.98]",
        secondary:
          "bg-sv-gray-700 text-sv-white hover:bg-sv-gray-600 active:scale-[0.98]",
        ghost:
          "text-sv-gray-300 hover:bg-sv-gray-700 hover:text-sv-white active:scale-[0.98]",
        link: "text-sv-white underline-offset-4 hover:underline",
        success:
          "bg-sv-green text-white hover:bg-sv-green-dim active:scale-[0.98]",
      },
      size: {
        default: "h-10 px-4 py-2 rounded-md",
        sm: "h-8 px-3 rounded-md text-xs",
        lg: "h-12 px-6 rounded-md text-base",
        xl: "h-14 px-8 rounded-lg text-base font-semibold",
        icon: "h-10 w-10 rounded-md",
        "icon-sm": "h-8 w-8 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
