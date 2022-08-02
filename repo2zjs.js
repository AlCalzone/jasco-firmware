// @ts-check

const { enumFilesRecursive } = require("@zwave-js/shared");
const { extractFirmware, guessFirmwareFileFormat } = require("@zwave-js/core");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const execa = require("execa");

const firmwarePath = path.join(__dirname, "zwave");
const outDir = path.join(__dirname, "out");

/**
 * @param {string} line
 * @returns {string[]}
 */
function scanCSVLine(line) {
  const result = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      result.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

/**
 * @param {string} string
 * @returns {string}
 */
function stripBom(string) {
  if (typeof string !== "string") {
    throw new TypeError(`Expected a string, got ${typeof string}`);
  }

  // Catches EFBBBF (UTF-8 BOM) because the buffer-to-string
  // conversion translates it to FEFF (UTF-16 BOM).
  if (string.charCodeAt(0) === 0xfeff) {
    return string.slice(1);
  }

  return string;
}

async function main() {
  const modelFiles = await enumFilesRecursive(firmwarePath, (file) =>
    file.endsWith(".csv")
  );

  /** @type {[string, any][]} */
  const results = [];

  let sha;
  try {
    await execa("git", ["fetch", "origin"]);
    sha = (await execa("git", ["rev-parse", "origin/main"])).stdout;
  } catch (e) {
    console.error(`Failed to fetch git sha of origin/main: ${e.message}`);
    console.error();
  }

  for (const file of modelFiles) {
    let content = stripBom(await fs.readFile(file, "utf8"));

    if (!content.startsWith("FIRMWARE REVISION HISTORY")) {
      console.error(`Skipping ${file}, unexpected format`);
      console.error();
      continue;
    }

    // console.log(`Processing ${file}`);

    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !!line);

    /** @type {string | undefined} */
    let model;
    /** @type {string | undefined} */
    let brand;
    /** @type {string | undefined} */
    let manufacturerId;
    /** @type {string | undefined} */
    let productType;
    /** @type {string | undefined} */
    let productId;
    /** @type {[string, string][]} */
    let changelogEntries = [];

    let isChangelog = false;
    let currentVersion;
    let currentChangelog;
    for (const line of lines) {
      const data = scanCSVLine(line);
      if (isChangelog) {
        // This line is part of the changelog.
        if (data[0]) {
          if (currentVersion && currentChangelog) {
            // Save the old entry
            changelogEntries.push([currentVersion, currentChangelog]);
          }
          // It is either the start of one entry
          currentVersion = data[0];
          currentChangelog = data[2].trim();
        } else if (currentVersion) {
          // or a continuation of the previous entry.
          currentChangelog += "\n" + data[2].trim();
        } else {
          console.error(`Skipping ${file}, unexpected changelog format`);
          console.error();
        }
      } else if (data[0] === "FIRMWARE REVISION HISTORY") {
        model = data[1];
        brand = data[2];
        // description = data[3];
      } else if (data[0].toLowerCase() === "manufacturer id") {
        manufacturerId = data[1];
      } else if (data[0].toLowerCase() === "product type id") {
        productType = data[1];
      } else if (data[0].toLowerCase() === "product id") {
        productId = data[1];
      } else if (data[0] === "VERSION") {
        isChangelog = true;
      }
    }

    // Save the last entry
    if (currentVersion && currentChangelog) {
      changelogEntries.push([currentVersion, currentChangelog]);
    }

    if (!model || !brand || !manufacturerId || !productType || !productId) {
      console.error(`Skipping ${file}, incomplete information`);
      console.error();
      continue;
    }

    const deviceInfo = {
      brand,
      model,
      manufacturerId,
      productType,
      productId,
    };
    const upgrades = [];
    for (const [version, changelog] of changelogEntries) {
      if (changelog.includes("OTA file will not be released")) {
        console.log(
          `Skipping ${file} version ${version}, unreleased firmware file`
        );
        console.log();
        continue;
      }

      // Find the corresponding file
      const upgradeDir = path.join(path.dirname(file), version);

      let upgradeFile;
      try {
        const files = await enumFilesRecursive(
          upgradeDir,
          (f) =>
            f.endsWith(".otz") ||
            f.endsWith(".ota") ||
            f.endsWith(".hex") ||
            f.endsWith(".bin")
        );
        if (files.length !== 1) {
          throw new Error("Ambiguous upgrade file");
        }
        upgradeFile = files[0];
      } catch {
        console.error(
          `Skipping ${file} version ${version}, failed to locate firmware file`
        );
        console.error();
        continue;
      }

      // Determine download URL
      const relativePath = path
        .relative(firmwarePath, upgradeFile)
        .replace(/\\/g, "/");
      const slug = relativePath
        .split("/")
        .filter((part) => !!part)
        .map((part) => encodeURIComponent(part))
        .join("/");
      const url = `https://raw.githubusercontent.com/jascoproducts/firmware/${sha}/zwave/${slug}`;

      // Determine integrity
      const rawData = await fs.readFile(upgradeFile);
      const format = guessFirmwareFileFormat(upgradeFile, rawData);
      const firmware = extractFirmware(rawData, format);

      const hasher = crypto.createHash("sha256");
      hasher.update(firmware.data);
      const hash = hasher.digest("hex");
      const integrity = `sha256:${hash}`;

      upgrades.push({
        version,
        changelog,
        url,
        integrity,
      });
    }

    if (upgrades.length === 0) {
      console.error(`Skipping ${file}, no available firmwares`);
      console.error();
      continue;
    }

    const output = {
      devices: [deviceInfo],
      upgrades,
    };

    const outputFilename = `out/${brand
      .toLowerCase()
      .replace(/[\/\s]+/g, "_")}/${model.replace(/[\/\s]+/g, "_")}.json`;

    results.push([outputFilename, output]);
    // console.log();
  }

  await fs.rm(outDir, { recursive: true, force: true });
  for (const [filename, content] of results) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(content, null, "\t") + "\n");
  }
  console.log("Done");
}
void main();
