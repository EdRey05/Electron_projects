import { useState } from "react";
import type { Job } from "@shared/types";
import { JobList } from "./pages/JobList";
import { JobBuilder } from "./pages/JobBuilder";
import { RunView } from "./pages/RunView";
import { History } from "./pages/History";

type Page =
  | { name: "list" }
  | { name: "builder"; initial?: Job }
  | { name: "run"; job: Job }
  | { name: "history"; job: Job };

export default function App() {
  const [page, setPage] = useState<Page>({ name: "list" });
  // refreshKey forces JobList to remount + refetch after a save/delete.
  const [refreshKey, setRefreshKey] = useState(0);

  function backToList() {
    setRefreshKey((k) => k + 1);
    setPage({ name: "list" });
  }

  switch (page.name) {
    case "list":
      return (
        <JobList
          key={refreshKey}
          onNew={() => setPage({ name: "builder" })}
          onEdit={(job) => setPage({ name: "builder", initial: job })}
          onRun={(job) => setPage({ name: "run", job })}
          onHistory={(job) => setPage({ name: "history", job })}
        />
      );
    case "builder":
      return (
        <JobBuilder
          initial={page.initial}
          onSaved={backToList}
          onCancel={backToList}
        />
      );
    case "run":
      return <RunView job={page.job} onBack={backToList} />;
    case "history":
      return <History job={page.job} onBack={backToList} />;
  }
}
