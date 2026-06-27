export function nextOrderNumber({ prefix, counter, today }) {
  const value = counter && counter.date === today ? counter.value + 1 : 50
  return {
    orderNumber: `${prefix}-${today}-${String(value).padStart(4, '0')}`,
    counter: { date: today, value },
  }
}
