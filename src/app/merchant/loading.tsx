import { PageLoading } from "@/components/page-loading";
import { MERCHANT_LEAD } from "./copy";

export default function MerchantLoading() {
  return (
    <PageLoading
      current="merchant"
      eyebrow="Merchant"
      title="Merchant insights"
      lead={MERCHANT_LEAD}
      tiles={4}
      cards={3}
    />
  );
}
