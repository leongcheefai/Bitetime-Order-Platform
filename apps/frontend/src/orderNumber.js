export function nextOrderNumber({ prefix, counter, today }) {
  const value = counter && counter.day === today ? counter.value + 1 : 50
  return {
    orderNumber: `${prefix}-${today}-${String(value).padStart(4, '0')}`,
    counter: { day: today, value },
  }
}
