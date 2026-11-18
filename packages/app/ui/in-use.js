// @ts-check
/**
 * The page a copy of OpenAssess shows when another copy has its library open (`src/library-lock.ts`). It says which library and
 * since when, and Try again asks the server to claim the library once more: when the other copy has been closed, the claim
 * succeeds and the app opens as usual. What is said aloud goes to the status line, which is in the page from the start and is
 * only written to, because a region built with its words already in it is often not read.
 */

/** @param {string} id */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @param {{ home?: string, since?: string } | null} inUse */
function show(inUse) {
  if (!inUse) {
    window.location.replace("/");
    return;
  }
  const since = inUse.since ? new Date(inUse.since) : undefined;
  byId("since").textContent = since && !Number.isNaN(since.getTime()) ? ` since ${since.toLocaleString()}` : "";
  byId("where").textContent = inUse.home ? `The library is the folder ${inUse.home}.` : "";
}

/**
 * @param {string} method
 * @param {string} path
 */
async function ask(method, path) {
  const reply = await fetch(`/api/${path}`, { method, headers: method === "GET" ? {} : { "x-openassess": "1" } });
  if (!reply.ok) throw new Error(`OpenAssess did not answer (${reply.status}).`);
  return /** @type {{ inUse: { home?: string, since?: string } | null }} */ (await reply.json());
}

const line = byId("status");
const button = /** @type {HTMLButtonElement} */ (byId("try-again"));

button.addEventListener("click", async () => {
  button.disabled = true;
  line.textContent = "";
  try {
    const { inUse } = await ask("POST", "library/try-again");
    if (inUse) {
      show(inUse);
      line.textContent = "The library is still open in the other copy. Close it there, then try again.";
    } else {
      line.textContent = "Opening the library.";
      show(null);
    }
  } catch (error) {
    line.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
});

ask("GET", "library/in-use")
  .then(({ inUse }) => show(inUse))
  .catch((error) => {
    line.textContent = error instanceof Error ? error.message : String(error);
  });
