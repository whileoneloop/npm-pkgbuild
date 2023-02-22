import { join } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { execa } from "execa";
import { EmptyContentEntry, ReadableStreamContentEntry } from "content-entry";
import {
  transform,
  createPropertiesInterceptor
} from "content-entry-transform";
import { iterableStringInterceptor } from "iterable-string-interceptor";
import {
  keyValueTransformer,
  equalSeparatedKeyValuePairOptions
} from "key-value-transformer";
import { aggregateFifo } from "aggregate-async-iterator";
import { Packager } from "./packager.mjs";
import {
  copyEntries,
  fieldProvider,
  quote,
  utf8StreamOptions,
  packageNameMapping
} from "../util.mjs";

function* keyValueLines(key, value, options) {
  yield `${keyPrefix(key)}${options.keyValueSeparator}${
    Array.isArray(value)
      ? "(" + value.map(v => quote(v)).join(" ") + ")"
      : quote(value)
  }${options.lineEnding}`;
}

/**
 * @type KeyValueTransformOptions
 * Options to describe key value pair separated by an equal sign '='
 */
export const pkgKeyValuePairOptions = {
  ...equalSeparatedKeyValuePairOptions,

  extractKeyValue: line => {
    const m = line.match(/^(#\s*)?(\w+)=\s*\((.*)\)|(.*)/);
    if (m) {
      return [m[2], m[3] ? m[3].split(/\s*,\s*/) : m[4]];
    }
  },
  keyValueLines
};

function keyPrefix(key) {
  const f = fields[key];
  return f?.prefix ? f.prefix + key : key;
}

const PKGBUILD = "PKGBUILD";

let _ext = ".pkg.tar.xz";
let _prepared;
let _architecture = "aarch64";

export class ARCH extends Packager {
  static get name() {
    return "arch";
  }

  static get description() {
    return "generate Arch-Linux package";
  }

  static get fileNameExtension() {
    return _ext;
  }

  static get fields() {
    return fields;
  }

  static async prepare(options={}, variant={}) {
    if (_prepared === undefined) {
      try {
        await execa("makepkg", ["-V"]);

        const cfg = await readFile("/etc/makepkg.conf", utf8StreamOptions);
        if (options.verbose) {
          console.log(cfg);
        }

        function getValue(key) {
          const i = cfg.indexOf(`${key}=`);
          if (i > 0) {
            const m = cfg
              .substring(i)
              .split(/\n/)[0]
              .match(/='([^'"]+)['"]/);
            return m && m[1];
          }
        }
        _ext = getValue("PKGEXT");
        _architecture = getValue("CARCH");
        _prepared = true;
      } catch(e) {
        _prepared = false;
      }
    }
 //   console.log("ARCH", variant.arch, _architecture,
 //    _prepared, (variant.arch === undefined || variant.arch === _architecture));
     
    return _prepared && (variant.arch === undefined || variant.arch === _architecture);
    }

  get packageFileName() {
    const p = this.properties;
    return `${p.name}-${p.version}-${p.release}-${p.arch}${this.fileNameExtension}`;
  }

  async execute(sources, transformer, dependencies, options, expander) {
    const { properties, staging, destination } = await this.prepareExecute(
      options
    );

    if (properties.source) {
      properties.md5sums = ["SKIP"];
    }
    if (properties.hooks) {
      properties.install = `${properties.name}.install`;
    }

    async function* trailingLines() {
      yield `
package() {
  depends=(${makeDepends(dependencies)
    .map(v => quote(v))
    .join(" ")})

  if [ "$(ls -A $srcdir)" ]
  then
    cp -rp $srcdir/* "$pkgdir"
  fi
}
`;
    }

    if (properties.backup?.[0] === "/") {
      properties.backup = properties.backup.replace(/\//, "");
    }

    if (properties.hooks) {
      await pipeline(
        iterableStringInterceptor(
          createReadStream(properties.hooks, utf8StreamOptions),
          createPropertiesInterceptor(properties)
        ),
        createWriteStream(join(staging, properties.install), utf8StreamOptions)
      );
    }

    const fp = fieldProvider(properties, fields);

    transformer.push({
      name: PKGBUILD,
      match: entry => entry.name === PKGBUILD,
      transform: async entry =>
        new ReadableStreamContentEntry(
          "../" + entry.name,
          keyValueTransformer(await entry.readStream, fp, {
            ...pkgKeyValuePairOptions,
            trailingLines
          })
        ),
      createEntryWhenMissing: () => new EmptyContentEntry(PKGBUILD)
    });

    for await (const file of copyEntries(
      transform(aggregateFifo(sources), transformer),
      join(staging, "src"),
      expander
    )) {
      if (options.verbose) {
        console.log(file.destination);
      }
    }

    if (options.verbose) {
      console.log(await readFile(join(staging, PKGBUILD), utf8StreamOptions));
    }

    if (!options.dry) {
      let PACKAGER;

      if (properties.contributors?.length > 0) {
        PACKAGER = person(properties.contributors);
      }

      const makepkg = await execa("makepkg", ["-f", "-e"], {
        cwd: staging,
        env: { PKGDEST: destination, PACKAGER }
      });

      if (options.verbose) {
        console.log(makepkg.stdout);
      }
    }

    return join(destination, this.packageFileName);
  }
}

function person(contributors) {
  return contributors[0].name + " " + contributors[0].email;
}

/**
 * well known package properties
 * https://www.archlinux.org/pacman/PKGBUILD.5.html
 */
const fields = {
  Maintainer: { alias: "maintainer", type: "string", prefix: "# " },

  pkgname: { alias: "name", type: "string[]", mandatory: true },
  pkgver: { alias: "version", type: "string", mandatory: true },
  pkgrel: { alias: "release", type: "integer", default: 1, mandatory: true },
  epoch: { type: "integer", default: 0 },
  pkgdesc: { alias: "description", type: "string", mandatory: true },
  url: { alias: "homepage", type: "string" },
  license: { type: "string[]", mandatory: true },
  install: { type: "string" },
  changelog: { type: "string" },
  source: { type: "string[]" },
  validpgpkeys: { type: "string[]" },
  noextract: { type: "string[]" },
  cksums: { type: "string[]" },
  md5sums: { type: "string[]" },
  sha1sums: { type: "string[]" },
  sha256sums: { type: "string[]" },
  sha384sums: { type: "string[]" },
  sha512sums: { type: "string[]" },
  groups: { type: "string[]" },
  arch: { default: ["any"], type: "string[]", mandatory: true },
  backup: { type: "string[]" },
  depends: { type: "string[]" },
  makedepends: { /*default: ["nodejs>=16.13.1"],*/ type: "string[]" },
  checkdepends: { type: "string[]" },
  optdepends: { type: "string[]" },
  conflicts: { type: "string[]" },
  provides: { type: "string[]" },
  replaces: { type: "string[]" },
  options: { type: "string[]" }
};

function normalizeExpression(e) {
  e = e.replace(/\-([\w\d]+)$/, "");
  if (e.match(/^\d+/)) {
    return `>=${e}`;
  }

  return e;
}

function makeDepends(dependencies) {
  return Object.entries(dependencies).map(
    ([name, version]) =>
      `${packageNameMapping[name] || name}${normalizeExpression(version)}`
  );
}
