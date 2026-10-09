/**
 * A flowchart drawn in HTML, not an image.
 *
 * A list of steps that reads top to bottom, with a fork where the flow really
 * forks. It is an ordered list underneath, so with styles off - or to a
 * screen reader - it is still the same steps in the same order, which a
 * picture of a diagram would not be.
 *
 * Every step says who does it. That is the point of the diagrams on this
 * site: the one actor drawn with a dashed edge is the AI, because everything
 * it produces is a proposal that the server checks before anything happens.
 */

export type FlowActor = "person" | "ai" | "server" | "razorpay" | "data";

export interface FlowNode {
  readonly title: string;
  readonly body: string;
  readonly actor: FlowActor;
  /** Shown instead of the actor's name - a page's path, for instance. */
  readonly tag?: string;
}

export interface FlowBranch {
  readonly label: string;
  readonly nodes: readonly FlowNode[];
  /** How the branch ends, when it does not rejoin the main line. */
  readonly end?: "stop" | "loop";
}

export type FlowItem =
  | { readonly kind: "node"; readonly node: FlowNode }
  | { readonly kind: "split"; readonly branches: readonly FlowBranch[] };

export const ACTOR_LABELS: Readonly<Record<FlowActor, string>> = {
  person: "You",
  ai: "AI, proposes only",
  server: "Server",
  razorpay: "Razorpay",
  data: "Database",
};

export const node = (
  actor: FlowActor,
  title: string,
  body: string,
  tag?: string,
): FlowItem => ({
  kind: "node",
  node: { actor, title, body, ...(tag === undefined ? {} : { tag }) },
});

/** A step inside a branch: the same shape as `node`, without the wrapper. */
export const step = (
  actor: FlowActor,
  title: string,
  body: string,
  tag?: string,
): FlowNode => ({ actor, title, body, ...(tag === undefined ? {} : { tag }) });

export const split = (...branches: FlowBranch[]): FlowItem => ({
  kind: "split",
  branches,
});

function Node({ node: item }: { readonly node: FlowNode }): React.JSX.Element {
  return (
    <div className="flow-node" data-actor={item.actor}>
      <span className="flow-actor">{item.tag ?? ACTOR_LABELS[item.actor]}</span>
      <strong className="flow-title">{item.title}</strong>
      <span className="flow-body">{item.body}</span>
    </div>
  );
}

export function Flowchart({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly FlowItem[];
}): React.JSX.Element {
  return (
    <ol className="flow" aria-label={label}>
      {items.map((item, index) =>
        item.kind === "node" ? (
          <li key={`${String(index)}-${item.node.title}`} className="flow-step">
            <Node node={item.node} />
          </li>
        ) : (
          <li key={`${String(index)}-split`} className="flow-step flow-split">
            <div className="flow-branches">
              {item.branches.map((branch) => (
                <div
                  key={branch.label}
                  className="flow-branch"
                  {...(branch.end === undefined ? {} : { "data-end": branch.end })}
                >
                  <span className="flow-branch-label">{branch.label}</span>
                  <ol className="flow flow-inner">
                    {branch.nodes.map((inner) => (
                      <li key={inner.title} className="flow-step">
                        <Node node={inner} />
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

/** The key to the edges: drawn once per page, above the first chart. */
export function FlowLegend(): React.JSX.Element {
  return (
    <ul className="flow-legend" aria-label="Who does each step">
      {(Object.keys(ACTOR_LABELS) as FlowActor[]).map((actor) => (
        <li key={actor} data-actor={actor}>
          <span className="flow-swatch" aria-hidden="true" />
          {ACTOR_LABELS[actor]}
        </li>
      ))}
    </ul>
  );
}
