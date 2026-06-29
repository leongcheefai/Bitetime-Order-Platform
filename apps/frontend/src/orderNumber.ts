interface OrderCounter {
  day: string
  value: number
}

export function nextOrderNumber({ prefix, counter, today }: {
  prefix: string
  counter?: OrderCounter | null
  today: string
}) {
  const value = counter && counter.day === today ? counter.value + 1 : 50
  return {
    orderNumber: `${prefix}-${today}-${String(value).padStart(4, '0')}`,
    counter: { day: today, value },
  }
}
