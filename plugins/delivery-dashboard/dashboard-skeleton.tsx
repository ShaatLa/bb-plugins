import { Card } from "./components/ui/card";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";

export function DashboardSkeleton() {
  return <LoadingSkeleton label="Loading GitHub metrics…" className="space-y-3">
    <div className="space-y-3 py-2"><Skeleton className="h-6 w-32" /><Skeleton className="h-4 w-64 max-w-full" /></div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{[0, 1, 2].map((key) => <Card key={key} className="space-y-3 p-4"><Skeleton className="h-4 w-28" /><Skeleton className="h-8 w-24" /><Skeleton className="h-3 w-3/4" /></Card>)}</div>
    <Card className="space-y-5 p-4 sm:p-5"><Skeleton className="h-5 w-32" /><div className="grid grid-cols-2 gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((key) => <div key={key} className="space-y-2"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-24 max-w-full" /></div>)}</div><Skeleton className="h-3 w-3/4" /></Card>
    <Card className="space-y-4 p-4"><Skeleton className="h-5 w-28" /><div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{[0, 1].map((key) => <div key={key} className="space-y-3"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /></div>)}</div></Card>
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{[0, 1].map((key) => <Card key={key} className="space-y-4 p-4"><Skeleton className="h-5 w-40" /><Skeleton className="h-40 w-full" /></Card>)}</div>
  </LoadingSkeleton>;
}
