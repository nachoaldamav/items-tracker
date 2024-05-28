import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/.env` });

import { URL } from 'url';
import * as fs from 'fs';
import simpleGit, { SimpleGit } from 'simple-git';
import axios, { AxiosResponse } from 'axios';
import { Launcher } from 'epicgames-client';

class Main {
  namespaceOffersCache: Record<string, any> = {};
  language: string;
  country: string;
  namespaces: string[];
  perPage: number;
  trackingStats: Record<string, any>;
  databasePath: string;
  launcher: Launcher;
  nsIndex: Record<string, any>;
  changelist: {
    namespace: string;
    changes: {
      type: string;
      updatedAt: string;
      item: string;
      from: string | boolean | number;
      to: string | boolean | number;
    }[];
  }[] = [];

  readonly queueSize = 1;

  constructor() {
    this.language = 'en';
    this.country = 'US';
    this.namespaces = [];
    this.perPage = 1000;
    this.trackingStats = {
      timeUnit: 'ms',
    };
    this.databasePath = `${__dirname}/database`;

    this.launcher = new Launcher({
      useWaitingRoom: false,
      useCommunicator: false,
    });

    this.launcher.init().then(() => {
      this.update();
    });
  }

  shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  async fetchNamespaces(): Promise<void> {
    const existsNSList = fs.existsSync('./ns-queue.json');

    if (existsNSList) {
      const nsList = JSON.parse(fs.readFileSync('./ns-queue.json', 'utf8'));
      const shuffledKeys = this.shuffleArray(Object.keys(nsList));

      // Get the queue size from the ns-queue.json file
      this.namespaces = shuffledKeys.slice(0, this.queueSize);
      this.nsIndex = shuffledKeys
        .slice(0, this.queueSize)
        .map((key: string) => nsList[key]);

      // Remove the first `queueSize` items from the ns-queue.json file
      const newData = shuffledKeys
        .slice(this.queueSize)
        .reduce((acc: any, key: string) => {
          acc[key] = nsList[key];
          return acc;
        }, {});

      // Save the new ns-queue.json file
      fs.writeFileSync('./ns-queue.json', JSON.stringify(newData, null, 2));

      const pendingNamespaces = Object.keys(newData).length;

      if (pendingNamespaces === 0) {
        console.log('No namespaces left in the queue...');
        // Remove the ns-queue.json file
        fs.unlinkSync('./ns-queue.json');
        return;
      }

      // Log number of namespaces in the queue
      console.log(
        `${
          Object.keys(nsList).length - this.namespaces.length
        } namespaces left in the queue...`
      );

      console.log(
        `Using ${this.namespaces.length} namespaces from the queue...`
      );
      return;
    }

    console.log(`No ns-queue.json file found, fetching namespaces...`);

    if (!process.env.NAMESPACES_URL) {
      throw new Error('No environment variable NAMESPACES_URL');
    }

    const url = new URL(process.env.NAMESPACES_URL);

    switch (url.protocol) {
      case 'http:':
      case 'https:':
        const response: AxiosResponse = await axios.get(url.href, {
          responseType: 'json',
        });

        const shuffledKeysNew = this.shuffleArray(Object.keys(response.data));

        this.namespaces = shuffledKeysNew.slice(0, this.queueSize);
        this.nsIndex = this.namespaces.map((key: string) => response.data[key]);

        // Remove the first `queueSize` items from the shuffled keys
        const newQueueData = shuffledKeysNew
          .slice(this.queueSize)
          .reduce((acc: any, key: string) => {
            acc[key] = response.data[key];
            return acc;
          }, {});

        // Save the new ns-queue.json file
        fs.writeFileSync(
          './ns-queue.json',
          JSON.stringify(newQueueData, null, 2)
        );

        break;

      case 'file:':
        const fileData = JSON.parse(fs.readFileSync(url.pathname, 'utf8'));
        const shuffledFileKeys = this.shuffleArray(Object.keys(fileData));

        this.namespaces = shuffledFileKeys.slice(0, this.queueSize);
        this.nsIndex = this.namespaces.map((key: string) => fileData[key]);

        // Remove the first `queueSize` items from the shuffled keys
        const newFileQueueData = shuffledFileKeys
          .slice(this.queueSize)
          .reduce((acc: any, key: string) => {
            acc[key] = fileData[key];
            return acc;
          }, {});

        // Save the new ns-queue.json file
        fs.writeFileSync(
          './ns-queue.json',
          JSON.stringify(newFileQueueData, null, 2)
        );
        break;

      default:
        throw new Error('Unsupported protocol: ' + url.protocol);
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
      this.trackingStats.lastUpdate
    ).toISOString();

    await this.sync();
    process.exit(0);
  }

  index(): void {
    console.log('Indexing...');
    const namespaces: Record<string, string[]> = {};
    const titles: { id: string; title: string }[] = [];
    const list: any[] = [];

    const itemsPath = `${this.databasePath}/items`;
    /* fs.readdirSync(itemsPath).forEach((fileName) => {
			
		}); */
    const files = fs.readdirSync(itemsPath);

    console.log(`Found ${files.length} items...`);

    console.log('::group::Indexing items...');

    for (const fileName of files) {
      if (fileName.substr(-5) !== '.json') continue;
      console.log(`Indexing ${fileName}...`);

      try {
        const item = JSON.parse(
          fs.readFileSync(`${itemsPath}/${fileName}`, 'utf8')
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
          item.developer || '',
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
      JSON.stringify(namespaces, null, 2)
    );
    fs.writeFileSync(
      `${this.databasePath}/titles.json`,
      JSON.stringify(titles, null, 2)
    );
    fs.writeFileSync(
      `${this.databasePath}/list.json`,
      JSON.stringify(list, null, 2)
    );

    console.log('::endgroup::');
  }

  async sync(): Promise<void> {
    if (this.changelist.length > 0) {
      const API_URL = 'https://changelog-api.snpm.workers.dev/';
      console.log('Syncing with API...');
      await axios
        .post(
          API_URL,
          {
            changelist: this.changelist,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
            },
          }
        )
        .then((response: AxiosResponse) => {
          console.log(`Synced with API: ${response.status}`);
          return response;
        })
        .catch((error: any) => {
          console.error('Error syncing with API', error.message);
        });
    } else {
      console.log('No changes to sync...');
    }

    if (!process.env.GIT_REMOTE) return;
    console.log('Syncing with repo...');
    const git: SimpleGit = simpleGit({
      baseDir: __dirname,
      binary: 'git',
    });
    await git.addConfig('hub.protocol', 'https');
    // await git.checkoutBranch("main", "origin/main");
    await git.checkout('main');
    await git.add([`${this.databasePath}/.`]);
    await git.add('./ns-queue.json');
    const status = await git.status();
    const changesCount =
      status.created.length +
      status.modified.length +
      status.deleted.length +
      status.renamed.length;
    if (changesCount === 0) return;
    fs.writeFileSync(
      `${this.databasePath}/tracking-stats.json`,
      JSON.stringify(this.trackingStats, null, 2)
    );
    await git.add([`${this.databasePath}/.`]);
    const commitMessage = `Update - ${new Date().toISOString()}`;
    await git.commit(commitMessage);
    await git.removeRemote('origin');
    await git.addRemote('origin', process.env.GIT_REMOTE);
    await git.push(['-u', 'origin', 'main']);
    console.log(
      `Changes have been committed to repo with message ${commitMessage}`
    );
  }

  async saveItem(item: Item): Promise<void> {
    try {
      const changes = this.getChangesForItem(item.id, item);
      fs.writeFileSync(
        `${__dirname}/database/items/${item.id}.json`,
        JSON.stringify(item, null, 2)
      );

      if (changes.length > 0) {
        this.changelist.push({
          namespace: item.namespace,
          changes: changes.map((change) => {
            return {
              ...change,
              updatedAt: item.lastModifiedDate,
            };
          }),
        });
      }
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
        paging.count || this.perPage
      );
      paging = result.paging;
      paging.start += paging.count;
      for (let i = 0; i < result.elements.length; ++i) {
        const element = result.elements[i];
        await this.saveItem(element);
      }
      console.log(
        `Got ${paging.count} items for namespace ${namespace}, total ${paging.total}, next start ${paging.start}`
      );
      await this.sleep(1000);
    } while (paging.start < paging.total);
  }

  async fetchItemsForNamespace(
    namespace: string,
    start = 0,
    count = 1000
  ): Promise<any> {
    try {
      const response: AxiosResponse = await this.launcher.http.sendGet(
        `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`
      );

      if (!response.data.elements || response.data.elements.length === 0) {
        console.log(
          `No items found for namespace ${namespace}, using alternative method...`
        );

        let offersData: any;

        if (!this.namespaceOffersCache[namespace]) {
          const responseOffers: AxiosResponse = await this.launcher.http
            .sendGet(
              `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/offers?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`
            )
            .catch((error: any) => {
              console.error(
                `Error fetching offers for namespace ${namespace}`,
                error
              );
              return {
                data: null,
              };
            });
          offersData = responseOffers.data;
        } else {
          console.log(`Using cached offers data for namespace ${namespace}...`);
          offersData = this.namespaceOffersCache[namespace];
        }

        if (
          !offersData ||
          !offersData.elements ||
          offersData.elements.length === 0
        ) {
          console.log(
            `No offers found for namespace ${namespace}, ignoring...`
          );
          return response.data;
        }

        this.namespaceOffersCache[namespace] = offersData;

        console.log(
          offersData.elements.map((element: any) => element.id).join(', ')
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
          `Found ${elements.length} items for namespace ${namespace}, fetching...`
        );

        const items: any[] = [];

        for (const element of elements) {
          if (element) {
            console.log(
              `Fetching item ${element} for namespace ${namespace}...`
            );
            const responseItem: AxiosResponse = await this.launcher.http
              .sendGet(
                `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${element}`
              )
              .then((response: AxiosResponse) => response);

            if (responseItem.data) {
              items.push(responseItem.data);
            }
          } else {
            console.log('Invalid element');
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
          namespace
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

        if (error.response.statusCode === 404) {
          return {
            elements: [],
            paging: {
              total: 0,
              count: 0,
              start: 0,
            },
          };
        }

        if (error.response.statusCode === 401) {
          console.log('Reauthenticating launcher...');
          this.launcher.logout();
          await this.launcher.init();
        }

        console.log(JSON.stringify(error.response, null, 2));
        console.log('Next attempt in 1s...');
        await this.sleep(5000);
        return this.fetchItemsForNamespace(namespace, start, count);
      }

      throw new Error(error);
    }
  }

  async addHiddenItems(data: any, namespace: string): Promise<any> {
    if (!this.nsIndex) {
      throw new Error('No namespace index found in this.nsIndex');
    }

    const offers = this.nsIndex[namespace];
    if (!offers) return data;

    console.log(
      `Trying to find hidden items for namespace ${namespace}... (offers: ${offers.length})`
    );

    const hiddenItems: any[] = [];
    for await (const offerId of offers) {
      console.log(`Fetching hidden items for offer ${offerId}...`);
      const url = new URL('https://store.epicgames.com/graphql');
      url.searchParams.append('operationName', 'getCatalogOfferSubItems');
      url.searchParams.append(
        'variables',
        JSON.stringify({
          locale: 'en-US',
          offerId: offerId,
          sandboxId: namespace,
        })
      );
      url.searchParams.append(
        'extensions',
        '{"persistedQuery":{"version":1,"sha256Hash":"7f0327250294745d88bb463ba90a9cf6d27cef7c5eb070c015e0def9e3471832"}}'
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
        console.log('No hidden items found');
        continue;
      }

      for await (const id of hiddenItemsIds) {
        const responseItem: AxiosResponse = await this.fetchWithRetry(
          `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${id}`
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
      (item) => !data.elements.some((element: any) => element.id === item.id)
    );

    console.log(
      `Found ${nonExistingItems.length} hidden items for namespace ${namespace} (total: ${hiddenItems.length})`
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
        if (error.message === 'errors.com.epicgames.catalog.item_not_found') {
          console.log(`Item not found: ${url}`);
          return {
            data: null,
          };
        }

        if (
          error.message ===
          'errors.com.epicgames.common.authentication.token_verification_failed'
        ) {
          console.log('Reauthenticating launcher...');
          this.launcher.logout();
          await this.launcher.init();
          continue;
        }

        lastError = error;
        console.log('Retrying...');
        await this.sleep(3000);
      }
    }

    throw new Error(`Failed to fetch data from ${url}: ${lastError.message}`);
  }

  getChangesForItem(
    itemId: string,
    newItem: Item
  ): {
    type: string;
    item: string;
    from: string | boolean | number;
    to: string | boolean | number;
  }[] {
    const oldItemPath = `${this.databasePath}/items/${itemId}.json`;
    if (!fs.existsSync(oldItemPath)) {
      return [
        {
          type: 'add:item',
          item: itemId,
          from: '',
          to: newItem.id,
        },
      ];
    }

    const oldItem = JSON.parse(fs.readFileSync(oldItemPath, 'utf8')) as Item;
    const changes: {
      type: string;
      item: string;
      from: string | boolean | number;
      to: string | boolean | number;
    }[] = [];

    if (oldItem.title !== newItem.title) {
      changes.push({
        type: 'update:title',
        item: oldItem.id,
        from: oldItem.title,
        to: newItem.title,
      });
    }

    if (oldItem.description !== newItem.description) {
      changes.push({
        type: 'update:description',
        item: oldItem.id,
        from: oldItem.description,
        to: newItem.description,
      });
    }

    if (oldItem.selfRefundable !== newItem.selfRefundable) {
      changes.push({
        type: 'update:selfRefundable',
        item: oldItem.id,
        from: oldItem.selfRefundable,
        to: newItem.selfRefundable,
      });
    }

    if (oldItem.unsearchable !== newItem.unsearchable) {
      changes.push({
        type: 'update:unsearchable',
        item: oldItem.id,
        from: oldItem.unsearchable,
        to: newItem.unsearchable,
      });
    }

    if (oldItem.status !== newItem.status) {
      changes.push({
        type: 'update:status',
        item: oldItem.id,
        from: oldItem.status,
        to: newItem.status,
      });
    }

    if (oldItem.creationDate !== newItem.creationDate) {
      changes.push({
        type: 'update:creationDate',
        item: oldItem.id,
        from: oldItem.creationDate,
        to: newItem.creationDate,
      });
    }

    // Custom Attributes
    const customAttributes = [
      'CanRunOffline',
      'PresenceId',
      'MonitorPresence',
      'UseAccessControl',
      'RequirementsJson',
      'CanSkipKoreanIdVerification',
      'FolderName',
      'CloudSaveFolder',
      'MaxSizeMB',
      'MainWindowProcessName',
      'RegistryPath',
      'ThirdPartyManagedApp',
      'AdditionalCommandline',
      'RegistryLocation',
      'ProcessNames',
      'RegistryKey',
    ];

    for (const attribute of customAttributes) {
      if (
        newItem.customAttributes?.[attribute] &&
        !oldItem.customAttributes?.[attribute]
      ) {
        changes.push({
          type: `add:${attribute}`,
          item: oldItem.id,
          from: '',
          to: newItem.customAttributes[attribute].value,
        });
      } else if (
        oldItem.customAttributes?.[attribute] &&
        !newItem.customAttributes?.[attribute]
      ) {
        changes.push({
          type: `remove:${attribute}`,
          item: oldItem.id,
          from: oldItem.customAttributes[attribute].value,
          to: '',
        });
      } else if (
        newItem.customAttributes?.[attribute] &&
        oldItem.customAttributes?.[attribute] &&
        newItem.customAttributes?.[attribute].value !==
          oldItem.customAttributes?.[attribute].value
      ) {
        changes.push({
          type: `update:${attribute}`,
          item: oldItem.id,
          from: oldItem.customAttributes[attribute].value,
          to: newItem.customAttributes[attribute].value,
        });
      }
    }

    // Key Images
    if (!oldItem.keyImages) {
      oldItem.keyImages = [];
    }

    const oldTypes = oldItem.keyImages.map((image) => image.type);
    const newTypes = (newItem.keyImages || []).map((image) => image.type);
    const addedTypes = newTypes.filter((type) => !oldTypes.includes(type));
    const removedTypes = oldTypes.filter((type) => !newTypes.includes(type));
    const updatedTypes = newTypes.filter((type) => oldTypes.includes(type));

    for (const type of addedTypes) {
      const newImage = newItem.keyImages.find(
        (image) => image.type === type
      ) as KeyImage;
      changes.push({
        type: `add:image:${type}`,
        item: oldItem.id,
        from: '',
        to: newImage.url,
      });
    }

    for (const type of removedTypes) {
      const oldImage = oldItem.keyImages.find(
        (image) => image.type === type
      ) as KeyImage;
      changes.push({
        type: `remove:image:${type}`,
        item: oldItem.id,
        from: oldImage.url,
        to: '',
      });
    }

    for (const type of updatedTypes) {
      const oldImage = oldItem.keyImages.find(
        (image) => image.type === type
      ) as KeyImage;
      const newImage = newItem.keyImages.find(
        (image) => image.type === type
      ) as KeyImage;
      if (oldImage.url !== newImage.url) {
        changes.push({
          type: `update:image:${type}`,
          item: oldItem.id,
          from: oldImage.url,
          to: newImage.url,
        });
      }
    }

    // Categories
    const oldCategories = oldItem.categories.map((category) => category.path);
    const newCategories = newItem.categories.map((category) => category.path);
    const addedCategories = newCategories.filter(
      (category) => !oldCategories.includes(category)
    );
    const removedCategories = oldCategories.filter(
      (category) => !newCategories.includes(category)
    );

    if (addedCategories.length > 0) {
      changes.push({
        type: 'add:categories',
        item: oldItem.id,
        from: oldCategories.join(', '),
        to: newCategories.join(', '),
      });
    }

    if (removedCategories.length > 0) {
      changes.push({
        type: 'remove:categories',
        item: oldItem.id,
        from: oldCategories.join(', '),
        to: newCategories.join(', '),
      });
    }

    // Release Info
    const oldReleaseInfo = oldItem.releaseInfo?.[0];
    const newReleaseInfo = newItem.releaseInfo?.[0];

    if (oldReleaseInfo && newReleaseInfo) {
      if (
        JSON.stringify(oldReleaseInfo.platform) !==
        JSON.stringify(newReleaseInfo.platform)
      ) {
        changes.push({
          type: 'update:platform',
          item: oldItem.id,
          from: oldReleaseInfo.platform.join(', '),
          to: newReleaseInfo.platform.join(', '),
        });
      }

      if (oldReleaseInfo.appId !== newReleaseInfo.appId) {
        changes.push({
          type: 'update:appId',
          item: oldItem.id,
          from: oldReleaseInfo.appId,
          to: newReleaseInfo.appId,
        });
      }
    } else if (oldReleaseInfo && !newReleaseInfo) {
      changes.push({
        type: 'remove:releaseInfo',
        item: oldItem.id,
        from: oldReleaseInfo.appId,
        to: '',
      });
    } else if (!oldReleaseInfo && newReleaseInfo) {
      changes.push({
        type: 'add:releaseInfo',
        item: oldItem.id,
        from: '',
        to: newReleaseInfo.appId,
      });
    }

    // eulaIds
    for (const eulaId of newItem.eulaIds || []) {
      if (!oldItem.eulaIds.includes(eulaId)) {
        changes.push({
          type: 'add:eulaId',
          item: oldItem.id,
          from: '',
          to: eulaId,
        });
      }
    }

    console.log(`Changes for ${itemId}: ${JSON.stringify(changes, null, 2)}`);

    return changes;
  }
}

export default new Main();

export interface Item {
  id: string;
  title: string;
  description: string;
  keyImages: KeyImage[];
  categories: Category[];
  namespace: string;
  status: string;
  creationDate: string;
  lastModifiedDate: string;
  customAttributes: CustomAttributes;
  entitlementName: string;
  entitlementType: string;
  itemType: string;
  releaseInfo: ReleaseInfo[];
  developer: string;
  developerId: string;
  eulaIds: string[];
  endOfSupport: boolean;
  ageGatings: AgeGatings;
  selfRefundable: boolean;
  unsearchable: boolean;
}

export interface KeyImage {
  type: string;
  url: string;
  md5: string;
  width: number;
  height: number;
  size: number;
  uploadedDate: string;
}

export interface Category {
  path: string;
}

export interface CustomAttributes {
  CanRunOffline?: CanRunOffline;
  PresenceId?: PresenceId;
  MonitorPresence?: MonitorPresence;
  UseAccessControl?: UseAccessControl;
  RequirementsJson?: RequirementsJson;
  CanSkipKoreanIdVerification?: CanSkipKoreanIdVerification;
  FolderName?: FolderName;
}

export interface CanRunOffline {
  type: string;
  value: string;
}

export interface PresenceId {
  type: string;
  value: string;
}

export interface MonitorPresence {
  type: string;
  value: string;
}

export interface UseAccessControl {
  type: string;
  value: string;
}

export interface RequirementsJson {
  type: string;
  value: string;
}

export interface CanSkipKoreanIdVerification {
  type: string;
  value: string;
}

export interface FolderName {
  type: string;
  value: string;
}

export interface ReleaseInfo {
  id: string;
  appId: string;
  platform: string[];
  dateAdded: string;
}

export interface AgeGatings {}
