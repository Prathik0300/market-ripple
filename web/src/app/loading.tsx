// Shown at once when moving between pages while the server renders the next one.
export default function Loading() {
  return (
    <main className="connect home" aria-busy="true" aria-label="Loading">
      <div className="skel">
        <i style={{ height: 34, width: "42%" }} />
        <i style={{ height: 16, width: "68%" }} />
        <div className="grid2">
          {[0, 1, 2, 3].map((k) => <i key={k} style={{ height: 240 }} />)}
        </div>
      </div>
    </main>
  );
}
