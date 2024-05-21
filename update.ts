import dotenv from "dotenv";
dotenv.config({ path: `${__dirname}/.env` });

import { URL } from "url";
import * as fs from "fs";
import simpleGit, { SimpleGit } from "simple-git";
import axios, { AxiosResponse } from "axios";
import { Launcher } from "epicgames-client";

class Main {
	namespaceOffersCache: Record<string, any> = {};
	language: string;
	country: string;
	namespaces: string[];
	perPage: number;
	trackingStats: Record<string, any>;
	databasePath: string;
	// @ts-expect-error
	launcher: Launcher;
	nsIndex: Record<string, any>;

	readonly queueSize = 100;

	constructor() {
		this.language = "en";
		this.country = "US";
		this.namespaces = [];
		this.perPage = 1000;
		this.trackingStats = {
			timeUnit: "ms",
		};
		this.databasePath = `${__dirname}/database`;

		this.launcher = new Launcher({
			useWaitingRoom: false,
			// @ts-expect-error
			useCommunicator: false,
		});

		this.launcher.init().then(() => {
			this.update();
		});
	}

	async fetchNamespaces(): Promise<void> {
		const existsNSList = fs.existsSync("./ns-queue.json");

		if (existsNSList) {
			const nsList = JSON.parse(fs.readFileSync("./ns-queue.json", "utf8"));
			// Get the queue size from the ns-queue.json file
			this.namespaces = Object.keys(nsList).slice(0, this.queueSize);
			this.nsIndex = Object.keys(nsList)
				.slice(0, this.queueSize)
				.map((key: string) => nsList[key]);

			// Remove the first 50 items from the ns-queue.json file
			const newData = Object.keys(nsList)
				.slice(this.queueSize)
				.reduce((acc: any, key: string) => {
					acc[key] = nsList[key];
					return acc;
				}, {});

			// Save the new ns-queue.json file
			fs.writeFileSync("./ns-queue.json", JSON.stringify(newData, null, 2));

			const pendingNamespaces = Object.keys(newData).length;

			if (pendingNamespaces === 0) {
				console.log("No namespaces left in the queue...");
				// Remove the ns-queue.json file
				fs.unlinkSync("./ns-queue.json");
				return;
			}

			// Log number of namespaces in the queue
			console.log(
				`${
					Object.keys(nsList).length - this.namespaces.length
				} namespaces left in the queue...`,
			);

			console.log(
				`Using ${this.namespaces.length} namespaces from the queue...`,
			);
			return;
		}

		console.log(`No ns-queue.json file found, fetching namespaces...`);

		if (!process.env.NAMESPACES_URL) {
			throw new Error("No environment variable NAMESPACES_URL");
		}

		const url = new URL(process.env.NAMESPACES_URL);

		switch (url.protocol) {
			case "http:":
			case "https:":
				const response: AxiosResponse = await axios.get(url.href, {
					responseType: "json",
				});

				// Save the list of namespaces to a queue file
				fs.writeFileSync(
					"./ns-queue.json",
					JSON.stringify(response.data, null, 2),
				);

				this.namespaces = Object.keys(response.data).slice(0, this.queueSize);
				// As it's an object, we need to convert it to an array, get the items and convert it back to an object
				this.nsIndex = Object.keys(response.data)
					.slice(0, this.queueSize)
					.map((key: string) => response.data[key]);

				break;

			case "file:":
				const fileData = JSON.parse(fs.readFileSync(url.pathname, "utf8"));
				this.namespaces = Object.keys(fileData);
				this.nsIndex = fileData;
				break;

			default:
				throw new Error("Unsupported protocol: " + url.protocol);
		}
	}

	async update(): Promise<void> {
		let checkpointTime: number;
		await this.fetchNamespaces();

		checkpointTime = Date.now();
		for (let i = 0; i < this.namespaces.length; ++i) {
			const namespace = this.namespaces[i];
			console.log(`Updating items for namespace ${namespace}...`);
			await this.fetchAllItemsForNamespace(namespace);
		}
		this.trackingStats.fetchItemsTime = Date.now() - checkpointTime;

		this.launcher.logout();

		checkpointTime = Date.now();
		this.index();
		this.trackingStats.indexTime = Date.now() - checkpointTime;

		this.trackingStats.lastUpdate = Date.now();
		this.trackingStats.lastUpdateString = new Date(
			this.trackingStats.lastUpdate,
		).toISOString();

		await this.sync();
		process.exit(0);
	}

	index(): void {
		console.log("Indexing...");
		const namespaces: Record<string, string[]> = {};
		const titles: { id: string; title: string }[] = [];
		const list: any[] = [];

		const itemsPath = `${this.databasePath}/items`;
		/* fs.readdirSync(itemsPath).forEach((fileName) => {
			
		}); */
		const files = fs.readdirSync(itemsPath);
		for (const fileName of files) {
			if (fileName.substr(-5) !== ".json") return;
			try {
				const item = JSON.parse(
					fs.readFileSync(`${itemsPath}/${fileName}`, "utf8"),
				);
				const itemList = { id: item.id, title: item.title };
				if (item.namespace) {
					if (!namespaces[item.namespace]) {
						namespaces[item.namespace] = [item.id];
					} else {
						namespaces[item.namespace].push(item.id);
					}
				}
				titles.push(itemList);
				list.push([
					item.id,
					item.namespace,
					item.title,
					(Array.isArray(item.categories) &&
						item.categories.map((c) => c.path)) ||
						[],
					item.developer || "",
					(item.creationDate &&
						Math.floor(new Date(item.creationDate).getTime() / 1000)) ||
						0,
					(item.lastModifiedDate &&
						Math.floor(new Date(item.lastModifiedDate).getTime() / 1000)) ||
						0,
				]);
			} catch (error) {
				console.error(error);
			}
		}
		fs.writeFileSync(
			`${this.databasePath}/namespaces.json`,
			JSON.stringify(namespaces, null, 2),
		);
		fs.writeFileSync(
			`${this.databasePath}/titles.json`,
			JSON.stringify(titles, null, 2),
		);
		fs.writeFileSync(
			`${this.databasePath}/list.json`,
			JSON.stringify(list, null, 2),
		);
	}

	async sync(): Promise<void> {
		if (!process.env.GIT_REMOTE) return;
		console.log("Syncing with repo...");
		const git: SimpleGit = simpleGit({
			baseDir: __dirname,
			binary: "git",
		});
		await git.addConfig("hub.protocol", "https");
		// await git.checkoutBranch("main", "origin/main");
		await git.checkout("main");
		await git.add([`${this.databasePath}/.`]);
		await git.add("./ns-queue.json");
		const status = await git.status();
		const changesCount =
			status.created.length +
			status.modified.length +
			status.deleted.length +
			status.renamed.length;
		if (changesCount === 0) return;
		fs.writeFileSync(
			`${this.databasePath}/tracking-stats.json`,
			JSON.stringify(this.trackingStats, null, 2),
		);
		await git.add([`${this.databasePath}/.`]);
		const commitMessage = `Update - ${new Date().toISOString()}`;
		await git.commit(commitMessage);
		await git.removeRemote("origin");
		await git.addRemote("origin", process.env.GIT_REMOTE);
		await git.push(["-u", "origin", "main"]);
		console.log(
			`Changes have been committed to repo with message ${commitMessage}`,
		);
	}

	saveItem(item: any): void {
		try {
			fs.writeFileSync(
				`${__dirname}/database/items/${item.id}.json`,
				JSON.stringify(item, null, 2),
			);
		} catch (error) {
			console.log(`${item.id} = ERROR`);
			console.error(error);
		}
	}

	sleep(time: number): Promise<void> {
		return new Promise((resolve) => {
			const sto = setTimeout(() => {
				clearTimeout(sto);
				resolve();
			}, time);
		});
	}

	async fetchAllItemsForNamespace(namespace: string): Promise<void> {
		let paging = { start: 0, count: 0, total: 0 };
		do {
			const result = await this.fetchItemsForNamespace(
				namespace,
				paging.start,
				paging.count || this.perPage,
			);
			paging = result.paging;
			paging.start += paging.count;
			for (let i = 0; i < result.elements.length; ++i) {
				const element = result.elements[i];
				this.saveItem(element);
			}
			console.log(
				`Got ${paging.count} items for namespace ${namespace}, total ${paging.total}, next start ${paging.start}`,
			);
			await this.sleep(1000);
		} while (paging.start < paging.total);
	}

	async fetchItemsForNamespace(
		namespace: string,
		start = 0,
		count = 1000,
	): Promise<any> {
		try {
			const response: AxiosResponse = await this.launcher.http.sendGet(
				`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`,
			);

			if (response.data.elements.length === 0) {
				console.log(
					`No items found for namespace ${namespace}, using alternative method...`,
				);

				let offersData: any;

				if (!this.namespaceOffersCache[namespace]) {
					const responseOffers: AxiosResponse =
						await this.launcher.http.sendGet(
							`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/offers?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`,
						);
					offersData = responseOffers.data;
				} else {
					console.log(`Using cached offers data for namespace ${namespace}...`);
					offersData = this.namespaceOffersCache[namespace];
				}

				if (offersData.elements.length === 0) {
					console.log(
						`No offers found for namespace ${namespace}, ignoring...`,
					);
					return response.data;
				}

				this.namespaceOffersCache[namespace] = offersData;

				console.log(
					offersData.elements.map((element: any) => element.id).join(", "),
				);

				const elements = offersData.elements
					.flatMap((element: any) => {
						const items = element.items.map((item: any) => {
							return item.mainGameItem?.id || item.id;
						});

						return items;
					})
					.filter((element: any) => element);

				console.log(elements);

				console.log(
					`Found ${elements.length} items for namespace ${namespace}, fetching...`,
				);

				const items: any[] = [];

				for (const element of elements) {
					if (element) {
						console.log(
							`Fetching item ${element} for namespace ${namespace}...`,
						);
						const responseItem: AxiosResponse = await this.launcher.http
							.sendGet(
								`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${element}`,
							)
							.then((response: AxiosResponse) => response)
							.catch((error: any) => {
								console.error(`Error fetching item ${element}`);
								return {
									data: null,
								};
							});

						if (responseItem.data) {
							items.push(responseItem.data);
						}
					} else {
						console.log("Invalid element");
					}
				}

				console.log(`Fetched ${items.length} items for namespace ${namespace}`);

				return this.addHiddenItems(
					{
						elements: items,
						paging: {
							total: items.length,
							count: items.length,
							start: 0,
						},
					},
					namespace,
				);
			}

			return this.addHiddenItems(response.data, namespace);
		} catch (error: any) {
			if (error.response) {
				if (error.response.data) {
					const result = error.response.data;
					if (result && result.elements && result.paging) {
						return result;
					}
				}

				if (error.response.status === 404) {
					return {
						elements: [],
						paging: {
							total: 0,
							count: 0,
							start: 0,
						},
					};
				}

				if (error.response.status === 401) {
					console.log("Reauthenticating launcher...");
					this.launcher.logout();
					await this.launcher.init();
				}

				console.log(JSON.stringify(error.response, null, 2));
				console.log("Next attempt in 1s...");
				await this.sleep(5000);
				return this.fetchItemsForNamespace(namespace, start, count);
			}

			throw new Error(error);
		}
	}

	async addHiddenItems(data: any, namespace: string): Promise<any> {
		if (!this.nsIndex) {
			throw new Error("No namespace index found in this.nsIndex");
		}

		const offers = this.nsIndex[namespace];
		if (!offers) return data;

		console.log(
			`Trying to find hidden items for namespace ${namespace}... (offers: ${offers.length})`,
		);

		const hiddenItems: any[] = [];
		for await (const offerId of offers) {
			console.log(`Fetching hidden items for offer ${offerId}...`);
			const url = new URL("https://store.epicgames.com/graphql");
			url.searchParams.append("operationName", "getCatalogOfferSubItems");
			url.searchParams.append(
				"variables",
				JSON.stringify({
					locale: "en-US",
					offerId: offerId,
					sandboxId: namespace,
				}),
			);
			url.searchParams.append(
				"extensions",
				'{"persistedQuery":{"version":1,"sha256Hash":"7f0327250294745d88bb463ba90a9cf6d27cef7c5eb070c015e0def9e3471832"}}',
			);

			const hiddenData = await this.fetchWithRetry(url.toString());
			const subItems = Array.isArray(hiddenData.data?.Catalog?.offerSubItems)
				? hiddenData.data?.Catalog?.offerSubItems
				: [];

			if (subItems.length === 0) {
				continue;
			}

			const hiddenItemsIds = subItems
				.map((item: any) => item.id)
				.filter((id: string) => id)
				.filter((id: string) => {
					return !data.elements.some((element: any) => element.id === id);
				});

			if (!hiddenItemsIds) {
				console.log("No hidden items found");
				continue;
			}

			for await (const id of hiddenItemsIds) {
				const responseItem: AxiosResponse = await this.fetchWithRetry(
					`https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${id}`,
				).catch((error: any) => {
					console.error(`Error fetching item ${id}: ${error.message}`);
					return {
						data: null,
					};
				});

				if (responseItem.data) {
					hiddenItems.push(responseItem.data);
				}
				await this.sleep(1000);
			}
			await this.sleep(1000);
		}

		const nonExistingItems = hiddenItems.filter(
			(item) => !data.elements.some((element: any) => element.id === item.id),
		);

		console.log(
			`Found ${nonExistingItems.length} hidden items for namespace ${namespace} (total: ${hiddenItems.length})`,
		);

		data.elements = data.elements.concat(nonExistingItems);

		return data;
	}

	async fetchWithRetry(url: string, retries = 3): Promise<any> {
		let lastError: any = null;
		for (let i = 0; i < retries; i++) {
			try {
				const response: AxiosResponse = await this.launcher.http.sendGet(url);
				return response.data;
			} catch (error: any) {
				if (error.message === "errors.com.epicgames.catalog.item_not_found") {
					console.log(`Item not found: ${url}`);
					return {
						data: null,
					};
				}

				if (
					error.message ===
					"errors.com.epicgames.common.authentication.token_verification_failed"
				) {
					console.log("Reauthenticating launcher...");
					this.launcher.logout();
					await this.launcher.init();
					continue;
				}

				lastError = error;
				console.log("Retrying...");
				await this.sleep(3000);
			}
		}

		throw new Error(`Failed to fetch data from ${url}: ${lastError.message}`);
	}
}

export default new Main();
