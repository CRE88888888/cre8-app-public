import { Link } from "react-router-dom";
import FundDesigner from "./FundDesigner";
import { useBodyClass } from "../../lib/use-body-class";
export function DesignFundPage() {
  useBodyClass("create-page", "atp-complete-create");
  return (
    // 副連結講清楚兩條路的差別：這裡是完整設計（每個資產可以有自己的策略），
    // 另一頁只設目標權重、馬上建立。
    <FundDesigner headingAction={<Link to="/create/activate">Just want target weights? Use the quick setup&nbsp;→</Link>} />
  );
}
