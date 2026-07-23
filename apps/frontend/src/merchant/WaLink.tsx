// A WhatsApp deep link — digits normalised out of the stored number.
// Shared by the customers table, the customer drawer header, and the order detail
// sheet. `stopClick` stops a click bubbling to a clickable row/card behind it
// (the customers table row opens a drawer on click) — harmless where there's no
// such parent.
export default function WaLink({ wa, stopClick = false }: { wa: string; stopClick?: boolean }) {
  return (
    <a
      href={`https://wa.me/${wa.replace(/\D/g, '')}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={stopClick ? e => e.stopPropagation() : undefined}
      // pixel-match of .mm-order-wa + :hover
      className="text-oxblood no-underline font-medium hover:underline"
    >
      {wa}
    </a>
  )
}
