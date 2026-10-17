import { PageLoading } from "@/components/page-loading";

export default function CheckoutLoading() {
  return <PageLoading current="shop" eyebrow="Payment" title={null} cards={1} />;
}
