import { Card } from "@/components/perceev/Card";
import { QueryManager } from "./QueryManager";

export const QueriesView = ({ brand, currentPrompts }) => {
  return (
    <Card variant="flush" style={{ height: "100%", overflow: "auto" }}>
      <QueryManager brand={brand} currentPrompts={currentPrompts} />
    </Card>
  );
};
