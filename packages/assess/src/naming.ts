/**
 * Every product-facing name lives here.
 *
 * The name of the tool is still an open decision (OpenAssess or OpenStage
 * Assess). Changing it is a one-file change as long as nothing else hard-codes
 * these strings, so nothing else may.
 */

export const PRODUCT_NAME = "OpenAssess";
export const PACKAGE_NAME = "@openstage/assess";
export const ENGINE_VERSION = "0.1.0";

/** File extension for a bank, with the leading dot. */
export const BANK_EXTENSION = ".openassess";

/** Written into every bank manifest so a reader can recognise the file. */
export const BANK_FORMAT = "openassess-bank";

/** Bumped when the on-disk shape of a bank changes. See model/migrate.ts. */
export const BANK_FORMAT_VERSION = 1;

/** Written into manifests so a bank records what produced it. */
export const GENERATOR = `${PACKAGE_NAME} ${ENGINE_VERSION}`;
