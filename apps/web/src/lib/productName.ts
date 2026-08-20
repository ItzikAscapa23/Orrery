export function productName(): string {
  return (import.meta.env['VITE_PRODUCT_NAME'] as string | undefined) ?? 'Orrery';
}
