/**
 * How a bank gets its name in the library, and how it leaves. A name is claimed so that two banks made at once never share one, and
 * the claim must never be a file that something else can see half made: the first claim was an empty file that the save then renamed
 * over, and on Windows a rename onto a file that another handle has open is refused, so a bank could not be made whenever anything
 * (the home screen's list, a second window, a virus scanner) happened to be reading that file. Alpha 21 made 100 of 100 banks under
 * that load; alpha 22 made 94 to 99 and listed the empty file as a bank that could not be read.
 *
 * Now a bank is saved whole under a private name that nothing lists, and given its name by a hard link (or, where the volume makes no
 * links, a copy that fails if the name is taken). The second half of this file makes each step of that fail.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BankStore, type BankStoreIo } from "../src/banks.ts";
import { Bank } from "../src/engine.ts";
import { fileOps, openLibrary, unlinkWhenFree, type FileOps, type Library } from "../src/library.ts";
import { withApp } from "./support/app.ts";

type Json = Record<string, any>;

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("making banks while the library is being read", () => {
  test("a hundred banks made one after another while the list is asked for again and again are all made, and none is listed as unreadable", async () => {
    await withApp(async (client) => {
      let stop = false;
      let listings = 0;
      const trouble: string[] = [];
      const poll = async (): Promise<void> => {
        while (!stop) {
          const reply = await client.get<Json>("/api/state");
          listings++;
          if (reply.status !== 200) trouble.push(`the list answered ${reply.status}`);
          else for (const bank of reply.json["banks"] as Array<{ name: string; error?: string }>) if (bank.error) trouble.push(`${bank.name}: ${bank.error}`);
        }
      };
      const pollers = [poll(), poll()];
      const failed: string[] = [];
      for (let i = 0; i < 100; i++) {
        const reply = await client.post<Json>("/api/banks", { title: `Serial ${i}` });
        if (reply.status !== 200) failed.push(`${i}: ${reply.status} ${reply.text.slice(0, 80)}`);
      }
      stop = true;
      await Promise.all(pollers);
      assert.deepEqual(failed, [], "every bank is made");
      assert.deepEqual(trouble.slice(0, 5), [], "and the list never showed one that could not be read");
      assert.ok(listings > 10, `${listings} listings were made while the banks were`);
      assert.equal(((await client.get<Json>("/api/state")).json["banks"] as unknown[]).length, 100);
    });
  });

  test("no file with a bank's name is ever empty or unfinished, from the moment the name is claimed", async () => {
    await withApp(async (client, home) => {
      const dir = join(home, "Banks");
      let stop = false;
      const seen: string[] = [];
      const watch = async (): Promise<void> => {
        while (!stop) {
          for (const file of readdirSync(dir)) {
            if (!file.endsWith(".openassess")) continue;
            try {
              const bytes = readFileSync(join(dir, file));
              if (bytes.length === 0 || bytes.subarray(0, 2).toString("latin1") !== "PK") seen.push(`${file} held ${bytes.length} bytes`);
            } catch {
              // a file that is moved while it is looked at is not a file that was seen unfinished
            }
          }
          await tick();
        }
      };
      const watching = watch();
      for (let i = 0; i < 30; i++) {
        const made = await client.post<Json>("/api/banks", { title: `Watched ${i}` });
        assert.equal(made.status, 200, made.text);
      }
      stop = true;
      await watching;
      assert.deepEqual(seen.slice(0, 5), [], "a bank file that is there is a whole bank");
    });
  });
});

describe("a bank that cannot be read", () => {
  test("can still be removed, into the folder of removed banks, and a bank that is not there is not found", async () => {
    await withApp(async (client, home) => {
      // What a crash between the claim of a name and the save used to leave, and what a copy cut short leaves.
      writeFileSync(join(home, "Banks", "Stub.openassess"), "");
      writeFileSync(join(home, "Banks", "Cut short.openassess"), "PK\u0003\u0004 and then nothing");
      const listed = (await client.get<Json>("/api/state")).json["banks"] as Array<{ name: string; error?: string }>;
      assert.deepEqual(listed.map((b) => [b.name, b.error !== undefined]), [["Cut short", true], ["Stub", true]], "both are listed, with what is wrong");
      assert.equal((await client.get("/api/banks/Stub")).status, 422, "and neither opens");
      for (const name of ["Stub", "Cut short"]) {
        const gone = await client.del(`/api/banks/${encodeURIComponent(name)}`);
        assert.equal(gone.status, 200, `${name}: ${gone.text}`);
      }
      assert.deepEqual(readdirSync(join(home, "Deleted")).sort(), ["Cut short.openassess", "Stub.openassess"], "they are kept, as they were");
      assert.equal(statSync(join(home, "Deleted", "Stub.openassess")).size, 0);
      assert.deepEqual(readdirSync(join(home, "Banks")), []);
      assert.equal(((await client.get<Json>("/api/state")).json["banks"] as unknown[]).length, 0);
      assert.equal((await client.del("/api/banks/Stub")).status, 404, "a bank that is not there is not found");
      assert.equal(existsSync(join(home, "Banks", "Stub.openassess")), false);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The claim, with the file system made to fail
// ---------------------------------------------------------------------------------------------------------------------------

const errno = (code: string): Error => Object.assign(new Error(`${code}: made to fail by the test`), { code });
const fails = (code: string) => async (): Promise<never> => {
  throw errno(code);
};

interface Spy {
  calls: { link: string[]; copyNew: string[]; unlink: string[]; remove: string[] };
  files: FileOps;
}

/** The real file system calls, each recorded, and any of them replaced. */
function spied(replace: Partial<FileOps> = {}): Spy {
  const calls = { link: [] as string[], copyNew: [] as string[], unlink: [] as string[], remove: [] as string[] };
  const files: FileOps = {
    ...fileOps,
    ...(replace.exists ? { exists: replace.exists } : {}),
    ...(replace.mkdir ? { mkdir: replace.mkdir } : {}),
    link: async (from, to) => {
      calls.link.push(to);
      return (replace.link ?? fileOps.link)(from, to);
    },
    copyNew: async (from, to) => {
      calls.copyNew.push(to);
      return (replace.copyNew ?? fileOps.copyNew)(from, to);
    },
    unlink: async (path) => {
      calls.unlink.push(path);
      return (replace.unlink ?? fileOps.unlink)(path);
    },
    remove: async (path) => {
      calls.remove.push(path);
      return (replace.remove ?? fileOps.remove)(path);
    },
  };
  return { calls, files };
}

async function inLibrary(fn: (library: Library) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "openassess-claim-"));
  try {
    await fn(await openLibrary(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const storeWith = (library: Library, io: BankStoreIo): BankStore => new BankStore(library, io);
const bankBytes = (title: string): Uint8Array => Bank.createEmpty(title).toBytes();

describe("a bank that cannot be saved leaves nothing behind", () => {
  test("whether the save wrote nothing or half a file, a new bank and an adopted one leave no bank and no private file", async () => {
    for (const how of ["nothing", "half"] as const) {
      const save = async (_bank: Bank, path: string): Promise<void> => {
        if (how === "half") writeFileSync(path, "PK half a bank");
        throw errno("ENOSPC");
      };
      await inLibrary(async (library) => {
        const store = storeWith(library, { save });
        await assert.rejects(() => store.create("Doomed"), /ENOSPC/, how);
        await assert.rejects(() => store.adopt(bankBytes("Doomed too"), "Doomed too.openassess"), /ENOSPC/, how);
        assert.deepEqual(readdirSync(library.banks), [], `${how}: no bank and no private file`);
        assert.deepEqual(await store.list(), []);
      });
    }
  });

  test("a save that really fails, because a file is where the Banks folder should be, leaves that file as it was", async () => {
    await inLibrary(async (library) => {
      rmSync(library.banks, { recursive: true });
      writeFileSync(library.banks, "this is a file where the Banks folder should be");
      await assert.rejects(() => storeWith(library, {}).create("Nowhere"));
      assert.equal(readFileSync(library.banks, "utf8"), "this is a file where the Banks folder should be");
    });
  });

  test("no file with a bank's extension exists until the bank is finished, and what is linked is a whole bank", async () => {
    const seen: string[][] = [];
    await inLibrary(async (library) => {
      const spy = spied({
        link: async (from, to) => {
          // The moment before the name is taken: the folder holds the private file, and it is a whole bank.
          seen.push(readdirSync(library.banks));
          assert.equal(Bank.fromBytes(new Uint8Array(readFileSync(from))).bank.manifest.title, "Whole");
          return fileOps.link(from, to);
        },
      });
      const store = storeWith(library, {
        files: spy.files,
        save: async (bank, path) => {
          seen.push(readdirSync(library.banks));
          await bank.save(path);
        },
      });
      assert.equal(await store.create("Whole"), "Whole");
    });
    assert.deepEqual(seen[0], [], "while the bank is being saved nothing has a bank's name");
    assert.equal(seen[1]?.length, 1, "and when it is finished there is the one private file");
    assert.ok(!seen[1]?.[0]?.endsWith(".openassess"), seen[1]?.[0]);
  });
});

describe("a bank takes a name by a link, and by a copy where there are no links", () => {
  test("the link is tried first, the private file is gone afterwards, and the bank opens", async () => {
    const spy = spied();
    await inLibrary(async (library) => {
      const store = storeWith(library, { files: spy.files });
      assert.equal(await store.create("Linked"), "Linked");
      assert.deepEqual(spy.calls.link.map((p) => p.slice(library.banks.length + 1)), ["Linked.openassess"]);
      assert.deepEqual(spy.calls.copyNew, [], "no copy was needed");
      assert.deepEqual(readdirSync(library.banks), ["Linked.openassess"]);
      assert.equal((await store.open("Linked")).manifest.title, "Linked");
    });
  });

  test("a name that is taken is the next number, and the numbers are in the length", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, {});
      const title = "t".repeat(80);
      assert.equal(await store.create(title), title);
      assert.equal(await store.create(title), `${"t".repeat(78)} 2`);
      assert.equal(await store.create(title), `${"t".repeat(78)} 3`);
      assert.equal(readdirSync(library.banks).length, 3);
      for (const name of readdirSync(library.banks)) assert.ok(name.length - ".openassess".length <= 80, name);
    });
  });

  test("a bank adopted from a file takes its name from the file, and the next number when that is taken", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, {});
      assert.deepEqual(await store.adopt(bankBytes("Brought"), "Brought in.openassess"), { name: "Brought in", skipped: 0 });
      assert.deepEqual(await store.adopt(bankBytes("Brought"), "Brought in.openassess"), { name: "Brought in 2", skipped: 0 });
      assert.deepEqual(readdirSync(library.banks).sort(), ["Brought in 2.openassess", "Brought in.openassess"]);
    });
  });

  test("a link that is not allowed makes a copy, a copy that finds the name taken goes on, and the result is the same bank", async () => {
    const spy = spied({ link: fails("EPERM") });
    await inLibrary(async (library) => {
      const store = storeWith(library, { files: spy.files });
      assert.equal(await store.create("Copied"), "Copied");
      assert.equal(await store.create("Copied"), "Copied 2");
      assert.equal(spy.calls.link.length, 3, "a link was tried for every name");
      assert.equal(spy.calls.copyNew.length, 3, "and a copy after each");
      assert.deepEqual(readdirSync(library.banks).sort(), ["Copied 2.openassess", "Copied.openassess"]);
      assert.equal((await store.open("Copied 2")).manifest.title, "Copied");
    });
  });

  test("when neither works and nothing is in the way, the error is the copy's own, nothing is left, and the names are not tried one after another", async () => {
    const spy = spied({ link: fails("EXDEV"), copyNew: fails("ENOSPC") });
    await inLibrary(async (library) => {
      await assert.rejects(() => storeWith(library, { files: spy.files }).create("Nothing works"), /ENOSPC/);
      assert.equal(spy.calls.copyNew.length, 1, "a failure that is not a taken name is not taken for one");
      assert.deepEqual(readdirSync(library.banks), []);
    });
  });

  test("a folder in the way is a name that is taken, whether the system says so for a link or only for a copy", async () => {
    for (const noLinks of [false, true]) {
      const spy = noLinks ? spied({ link: fails("EPERM") }) : spied();
      await inLibrary(async (library) => {
        mkdirSync(join(library.banks, "Folder.openassess"));
        assert.equal(await storeWith(library, { files: spy.files }).create("Folder"), "Folder 2", noLinks ? "by a copy" : "by a link");
        assert.deepEqual(readdirSync(library.banks).sort(), ["Folder 2.openassess", "Folder.openassess"]);
      });
    }
  });

  test("ten thousand names are tried and then it is said that the folder is full, with nothing left", async () => {
    const spy = spied({ link: fails("EEXIST") });
    await inLibrary(async (library) => {
      await assert.rejects(
        () => storeWith(library, { files: spy.files }).create("Crowded"),
        (error: Error) => /too many files with that name/.test(error.message) && (error as { status?: number }).status === 400,
      );
      assert.equal(spy.calls.link.length, 9_999, "the name itself and 2 to 9,999");
      assert.equal(spy.calls.link.at(-1)?.slice(library.banks.length + 1), "Crowded 9999.openassess");
      assert.equal(spy.calls.copyNew.length, 0, "a name that is taken is not copied to");
      assert.deepEqual(readdirSync(library.banks), []);
    });
  });

  test("a library folder taken away is made again before a bank is made, and before one is removed", async () => {
    await inLibrary(async (library) => {
      rmSync(library.banks, { recursive: true });
      const store = storeWith(library, {});
      assert.equal(await store.create("Back"), "Back");
      assert.deepEqual(readdirSync(library.banks), ["Back.openassess"]);
      rmSync(library.deleted, { recursive: true });
      assert.equal(await store.remove("Back"), join(library.deleted, "Back.openassess"));
      assert.deepEqual(readdirSync(library.deleted), ["Back.openassess"]);
    });
  });

  test("the name is the title as cleanName makes it, so a title a file cannot be called is still a bank", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, {});
      assert.equal(await store.create("Quiz: part 1/2"), "Quiz- part 1-2");
      assert.equal(await store.create("  Aux. Verbs  "), "Aux_. Verbs");
      assert.deepEqual(readdirSync(library.banks).sort(), ["Aux_. Verbs.openassess", "Quiz- part 1-2.openassess"]);
      assert.equal((await store.open("Quiz- part 1-2")).manifest.title, "Quiz: part 1/2", "and the title is what was typed");
    });
  });

  test("what the banks are listed from never includes a private file, a half-written one, or any other file", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, {});
      await store.create("Real");
      for (const stray of [".new-0123456789abcdef.tmp", "Real.openassess.123-abcdef.writing", "Real.openassess.writing", "notes.txt", "Real.openassess.bak"]) writeFileSync(join(library.banks, stray), "stray");
      assert.deepEqual((await store.list()).map((b) => b.name), ["Real"]);
    });
  });
});

describe("a name taken off a file that is busy", () => {
  const busyTwice = (code: string): { take: (path: string) => Promise<void>; calls: number[] } => {
    const calls: number[] = [];
    return {
      calls,
      take: async () => {
        calls.push(calls.length);
        if (calls.length <= 2) throw errno(code);
      },
    };
  };

  test("is tried again when the system says busy, and the file is let go when it frees", async () => {
    for (const code of ["EBUSY", "EPERM", "EACCES"]) {
      const { take, calls } = busyTwice(code);
      await unlinkWhenFree("x", take);
      assert.equal(calls.length, 3, code);
    }
  });

  test("is tried a few times and then refused, and any other answer is the first one", async () => {
    const forever: number[] = [];
    await assert.rejects(() => unlinkWhenFree("x", async () => void (forever.push(1), await Promise.reject(errno("EBUSY"))), 4), /EBUSY/);
    assert.equal(forever.length, 4);
    const missing: number[] = [];
    await assert.rejects(() => unlinkWhenFree("x", async () => void (missing.push(1), await Promise.reject(errno("ENOENT")))), /ENOENT/);
    assert.equal(missing.length, 1, "a file that is not there is not waited for");
  });
});

describe("a bank is removed by giving it a second name and taking the first away", () => {
  test("the bank is in Deleted before it leaves Banks, and a bank removed twice keeps both", async () => {
    const inDeletedWhenTaken: boolean[] = [];
    await inLibrary(async (library) => {
      const spy = spied({
        unlink: async (path) => {
          inDeletedWhenTaken.push(readdirSync(library.deleted).length > 0 && existsSync(path));
          return fileOps.unlink(path);
        },
      });
      const store = storeWith(library, { files: spy.files });
      await store.create("Old");
      assert.equal(await store.remove("Old"), join(library.deleted, "Old.openassess"));
      await store.create("Old");
      assert.equal(await store.remove("Old"), join(library.deleted, "Old 2.openassess"));
      assert.deepEqual(readdirSync(library.deleted).sort(), ["Old 2.openassess", "Old.openassess"]);
      assert.deepEqual(readdirSync(library.banks), []);
    });
    assert.deepEqual(inDeletedWhenTaken, [true, true], "the bank was in Deleted when it was taken out of Banks");
  });

  test("a name that cannot be taken off leaves the bank where it was, and not in Deleted as well", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, { files: spied({ unlink: fails("EBUSY") }).files });
      await store.create("Held");
      await assert.rejects(() => store.remove("Held"), /EBUSY/);
      assert.deepEqual(readdirSync(library.banks), ["Held.openassess"]);
      assert.deepEqual(readdirSync(library.deleted), []);
      assert.equal((await store.open("Held")).manifest.title, "Held", "and it opens");
    });
  });

  test("a name that was taken off by someone else meanwhile is a bank that is not there, and Deleted holds no second copy", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, { files: spied({ unlink: fails("ENOENT") }).files });
      await store.create("Gone");
      await assert.rejects(() => store.remove("Gone"), (error: Error) => (error as { status?: number }).status === 404);
      assert.deepEqual(readdirSync(library.deleted), []);
    });
  });

  test("where the second name cannot be made, the bank is not touched", async () => {
    await inLibrary(async (library) => {
      await storeWith(library, {}).create("Stays");
      const spy = spied({ link: fails("EPERM"), copyNew: fails("ENOSPC") });
      const store = storeWith(library, { files: spy.files });
      await assert.rejects(() => store.remove("Stays"), /ENOSPC/);
      assert.deepEqual(readdirSync(library.banks), ["Stays.openassess"]);
      assert.deepEqual(spy.calls.unlink, [], "nothing was taken off");
      assert.equal((await store.open("Stays")).manifest.title, "Stays");
    });
  });

  test("on a volume with no links the bank is copied to Deleted and then taken off its first name", async () => {
    await inLibrary(async (library) => {
      const store = storeWith(library, { files: spied({ link: fails("UNKNOWN") }).files });
      await store.create("Moved");
      await store.remove("Moved");
      assert.deepEqual(readdirSync(library.banks), []);
      assert.equal(Bank.fromBytes(new Uint8Array(readFileSync(join(library.deleted, "Moved.openassess")))).bank.manifest.title, "Moved");
    });
  });
});
