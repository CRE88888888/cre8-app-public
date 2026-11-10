import { Link } from "react-router-dom";
import FundBuilder from "../../reference/components/fund-builder";
import { useBodyClass } from "../../lib/use-body-class";
export function DesignFundPage() {
  useBodyClass("create-page", "atp-complete-create");
  return (
    <>
      <div className="public-create-actions">
        <span>Design your fund</span>
        <Link className="btn ghost sm" to="/create/activate">
          Activate an allocation ↗
        </Link>
      </div>
      <FundBuilder />
    </>
  );
}
