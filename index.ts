/// <reference path="untyped.d.ts" />

import cjs from "citation-js";
import * as fs from "fs";
import {
	Cite,
	Elt,
	Format,
	Link,
	Space,
	filterAsync,
	FilterAction,
	FilterActionAsync
} from "pandoc-filter";
import { isURL, toMeta, fromMetaMap } from "./util";

/** type of the citation-cache.json file */
type Cache = {
	_info: string;
	urls: { [url: string]: { fetched: string; bibtex: string[]; csl: any } };
};

async function getCslForUrl(url: string) {
	// uses zotero extractors from https://github.com/zotero/translators to get information from URLs
	// https://www.mediawiki.org/wiki/Citoid/API
	// It should be possible to run a citoid or [zotero translation-server](https://github.com/zotero/translation-server) locally,
	// but this works fine for now and is much simpler than trying to run that server in e.g. docker automatically.
	// A server is needed since Zotero extractors run within the JS context of the website.
	// It might be possible to fake the context and just run most extractors in Node, but that would be much more fragile and need a lot of testing.
	// It should also be possible to use something like puppeteer to fetch the website headlessly and then run the extractor.

	console.warn("fetching citation from url", url);
	const res = await fetch(
		`https://en.wikipedia.org/api/rest_v1/data/citation/bibtex/${encodeURIComponent(
			url
		)}`
	);

	if (!res.ok) {
		throw Error(
			`could not fetch citation from ${url}: ${await res.text()}`
		);
	}
	const bibtex = await res.text();
	let cbb;
	try {
		// Citoid does not have CSL output, so convert bibtex to CSL JSON format
		cbb = new cjs(bibtex.replace("{\\textbar}", "--")); // https://github.com/larsgw/citation.js/issues/194
	} catch (e) {
		console.warn("could not parse bibtex: ", bibtex);
		throw e;
	}

	if (cbb.data.length !== 1)
		throw Error("got != 1 bibtex entries: " + bibtex);
	cbb.data[0].id = url; // replace server-generated (useless) id with url
	const [csl] = cbb.get({ format: "real", type: "json", style: "csl" });
	delete csl._graph; // would be unnecessary bloat in json

	return {
		fetched: new Date().toJSON(),
		bibtex: bibtex.replace(/\t/g, "   ").split("\n"), // split to make json file more readable
		csl
	};
}

export class Url2Cite {
	/** written to CWD from which pandoc is called */
	citationCachePath = "citation-cache.json";
	cache: Cache = {
		_info:
			"Auto-generated by pandoc-url2cite. Feel free to modify, keys will never be overwritten.",
		urls: {}
	};

	citekeys: { [key: string]: string } = {};

	constructor() {
		try {
			this.cache = JSON.parse(
				fs.readFileSync(this.citationCachePath, "utf8")
			);
		} catch {}
	}

	async getCslForUrlCached(url: string) {
		if (url in this.cache.urls) return;
		this.cache.urls[url] = await getCslForUrl(url);
		// Write cache after every successful fetch. Somewhat inefficient.
		this.writeCache();
	}

	// Only needed for link syntax (not pandoc cite syntax)
	//
	// Since pandoc (with citations extension) does not parse `[@name]: http://...` as
	// [link reference definitions](https://spec.commonmark.org/0.29/#link-reference-definition)
	// we convert them ourselves. This leads to small inconsistencies in what you can do vs. in normal reference definitions:
	// 1. They need to be in their own paragraph.
	// 2. link title is not parsed (but also would not be used anyways)
	extractCiteKeys: FilterActionAsync = async (el, _outputFormat, _meta) => {
		if (el.t === "Para") {
			while (
				el.c.length >= 3 &&
				el.c[0].t === "Cite" &&
				el.c[0].c[0].length === 1 &&
				el.c[1].t === "Str" &&
				el.c[1].c === ":"
			) {
				const sp = el.c[2].t === "Space" ? 3 : 2;
				const v = el.c[sp];
				if (v.t === "Str") {
					// paragraph starts with [@something]: something
					// save info to citekeys and remove from paragraph
					const key = el.c[0].c[0][0].citationId;
					const url = v.c;
					if (key in this.citekeys)
						console.warn("warning: duplicate citekey", key);
					this.citekeys[key] = url;
					// found citation, add it to citekeys and remove it from document
					el.c = el.c.slice(sp + 1);
					if (el.c.length > 0 && el.c[0].t === "SoftBreak")
						el.c.shift();
				}
			}
			return el;
		}
	};
	/**
	 * transform the pandoc document AST
	 * - replaces links with citations if `all-links` is active or they are marked with `url2cite` class/title
	 * - replaces citekeys with urls, fetches missing citations and writes them to cache
	 */
	astTransformer: FilterActionAsync = async (el, _outputFormat, m) => {
		if (el.t === "Cite") {
			const [citations, _inline] = el.c;
			for (const citation of citations) {
				const id = citation.citationId;
				const url = isURL(id) ? id : this.citekeys[id];
				if (!url) throw `Error: Could not find URL for @${id}`;
				if (typeof url !== "string")
					throw Error(`url for ${id} is not string: ${url}`);
				await this.getCslForUrlCached(url);
				// replace the citation id with the url
				citation.citationId = url;
			}
		} else if (el.t === "Link") {
			const meta = fromMetaMap(m);
			if (meta.url2cite && typeof meta.url2cite !== "string")
				throw Error("unsupported value of url2cite");
			const [[id, classes, kv], inline, [url, targetTitle]] = el.c;

			if (
				meta.url2cite === "all-links" ||
				classes.includes("url2cite") ||
				/\burl2cite\b/.test(targetTitle)
			) {
				if (
					classes.includes("no-url2cite") ||
					/\bno-url2cite\b/.test(targetTitle)
				) {
					// disabling per link overrides enabling
					return;
				}
				if (!isURL(url)) {
					// probably a relative URL. Keep it as is
					return;
				}
				// here we basically convert a link of form [text](href)
				// to one of form [text [@{href}]](href)
				await this.getCslForUrlCached(url);
				const cite = Cite(
					[
						{
							citationSuffix: [],
							citationNoteNum: 0,
							citationMode: {
								t: "NormalCitation"
							} as any, // wrong typings
							citationPrefix: [],
							citationId: url,
							citationHash: 0
						}
					],
					[]
				);

				const e: Elt<"Link"> = Link(
					[id, classes, kv],
					[...inline, Space(), cite],
					[url, targetTitle]
				);

				return e;
			}
		}
	};

	async transform(data: any, format: Format) {
		// untyped https://github.com/mvhenderson/pandoc-filter-node/issues/9
		data = await filterAsync(data, this.extractCiteKeys, format);
		data = await filterAsync(data, this.astTransformer, format);
		console.warn(
			`got all ${Object.keys(this.cache.urls).length} citations from URLs`
		);
		// add all cached references to the frontmatter. pandoc-citeproc will handle (ignore) unused keys.
		data.meta.references = toMeta(
			Object.entries(this.cache.urls).map(([url, { csl }]) => csl)
		);
		return data;
	}
	writeCache() {
		fs.writeFileSync(
			this.citationCachePath,
			JSON.stringify(this.cache, null, "\t")
		);
	}
}
