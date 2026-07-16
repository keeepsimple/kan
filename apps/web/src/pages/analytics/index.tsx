import type { NextPageWithLayout } from "~/pages/_app";
import { getDashboardLayout } from "~/components/Dashboard";
import AnalyticsView from "~/views/analytics";

const AnalyticsPage: NextPageWithLayout = () => {
  return <AnalyticsView />;
};

AnalyticsPage.getLayout = (page) => getDashboardLayout(page);

export default AnalyticsPage;
