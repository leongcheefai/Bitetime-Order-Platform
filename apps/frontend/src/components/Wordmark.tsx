import logo from '../assets/tinyorder-logo.png'
import logo2x from '../assets/tinyorder-logo@2x.png'
import { cn } from '@/lib/utils'

// The TinyOrder brand lockup — receipt mark + serif wordmark.
// Everywhere the app used to render the bare string "TinyOrder" in Lora now
// renders this instead, so the brand only has to be corrected in one place.
// Size it with a height class (`h-7`, `h-[26px]`); width follows the ratio.
export default function Wordmark({ className }: { className?: string }) {
  return (
    <img
      src={logo}
      srcSet={`${logo} 1x, ${logo2x} 2x`}
      // Intrinsic size keeps the row from reflowing before the PNG decodes;
      // the height class below overrides it, w-auto keeps the 875:161 ratio.
      width={875}
      height={161}
      alt="TinyOrder"
      draggable={false}
      className={cn('block w-auto select-none', className)}
    />
  )
}
