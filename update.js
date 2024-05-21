require('dotenv').config({ path: `${__dirname}/.env` });
const Url = require('url');
const Fs = require('fs');
const SimpleGit = require('simple-git');
const Axios = require('axios');
const { Launcher } = require('epicgames-client');

class Main {
  namespaceOffersCache = {};

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

  async fetchNamespaces() {
    if (!process.env.NAMESPACES_URL) {
      throw new Error('No enviroment variable NAMESPACES_URL');
    }

    var url = Url.parse(process.env.NAMESPACES_URL);

    switch (url.protocol) {
      case 'http:':
      case 'https:':
        const { data } = await Axios.get(url.href, {
          responseType: 'json',
        });
        this.namespaces = Object.keys(data);
        this.nsIndex = data;
        break;

      case 'file:':
        this.namespaces = Object.keys(JSON.parse(Fs.readFileSync(url.path)));
        this.nsIndex = JSON.parse(Fs.readFileSync(url.path));
        break;

      default:
        throw new Error('Unsupported protocol: ' + url.protocol);
    }
  }

  async update() {
    let checkpointTime;
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

  index() {
    console.log('Indexing...');
    const namespaces = {};
    const titles = [];
    const list = [];

    const itemsPath = `${this.databasePath}/items`;
    Fs.readdirSync(itemsPath).forEach((fileName) => {
      if (fileName.substr(-5) !== '.json') return;
      try {
        const item = JSON.parse(Fs.readFileSync(`${itemsPath}/${fileName}`));
        var itemList = { id: item.id, title: item.title };
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
    });

    Fs.writeFileSync(
      `${this.databasePath}/namespaces.json`,
      JSON.stringify(namespaces, null, 2)
    );
    Fs.writeFileSync(
      `${this.databasePath}/titles.json`,
      JSON.stringify(titles, null, 2)
    );
    Fs.writeFileSync(
      `${this.databasePath}/list.json`,
      JSON.stringify(list, null, 2)
    );
  }

  async sync() {
    if (!process.env.GIT_REMOTE) return;
    console.log('Syncing with repo...');
    const git = SimpleGit({
      baseDir: __dirname,
      binary: 'git',
    });
    await git.addConfig('hub.protocol', 'https');
    await git.checkoutBranch('master');
    await git.add([`${this.databasePath}/.`]);
    const status = await git.status();
    const changesCount =
      status.created.length +
      status.modified.length +
      status.deleted.length +
      status.renamed.length;
    if (changesCount === 0) return;
    Fs.writeFileSync(
      `${this.databasePath}/tracking-stats.json`,
      JSON.stringify(this.trackingStats, null, 2)
    );
    await git.add([`${this.databasePath}/.`]);
    const commitMessage = `Update - ${new Date().toISOString()}`;
    await git.commit(commitMessage);
    await git.removeRemote('origin');
    await git.addRemote('origin', process.env.GIT_REMOTE);
    await git.push(['-u', 'origin', 'main']);
    console.log(`Changes has commited to repo with message ${commitMessage}`);
  }

  saveItem(item) {
    try {
      Fs.writeFileSync(
        `${__dirname}/database/items/${item.id}.json`,
        JSON.stringify(item, null, 2)
      );
    } catch (error) {
      console.log(`${item.id} = ERROR`);
      console.error(error);
    }
  }

  sleep(time) {
    return new Promise((resolve) => {
      const sto = setTimeout(() => {
        clearTimeout(sto);
        resolve();
      }, time);
    });
  }

  async fetchAllItemsForNamespace(namespace) {
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
        this.saveItem(element);
      }
      console.log(
        `Got ${paging.count} items for namespace ${namespace}, total ${paging.total}, next start ${paging.start}`
      );
      await this.sleep(1000);
    } while (paging.start < paging.total);
  }

  async fetchItemsForNamespace(namespace, start = 0, count = 1000) {
    try {
      const { data } = await this.launcher.http.sendGet(
        `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`
      );

      if (data.elements.length === 0) {
        console.log(
          `No items found for namespace ${namespace}, using alternative method...`
        );

        let offersData;

        if (!this.namespaceOffersCache[namespace]) {
          const { data } = await this.launcher.http.sendGet(
            `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/offers?status=SUNSET%7CACTIVE&sortBy=creationDate&country=${this.country}&locale=${this.language}&start=${start}&count=${count}`
          );
          offersData = data;
        } else {
          console.log(`Using cached offers data for namespace ${namespace}...`);
          offersData = this.namespaceOffersCache[namespace];
        }

        if (offersData.elements.length === 0) {
          console.log(
            `No offers found for namespace ${namespace}, ignoring...`
          );
          return data;
        }

        this.namespaceOffersCache[namespace] = offersData;

        console.log(
          offersData.elements.map((element) => element.id).join(', ')
        );

        // elements[n].item[n].mainGameItem?.id OR item[n].id
        const elements = offersData.elements
          .flatMap((element) => {
            const items = element.items.map((item) => {
              return item.mainGameItem?.id || item.id;
            });

            return items;
          })
          .filter((element) => element);

        console.log(elements);

        console.log(
          `Found ${elements.length} items for namespace ${namespace}, fetching...`
        );

        const items = [];

        for (const element of elements) {
          if (element) {
            console.log(
              `Fetching item ${element} for namespace ${namespace}...`
            );
            const { data } = await this.launcher.http
              .sendGet(
                `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${element}`
              )
              .then((response) => response)
              .catch((error) => {
                console.error(`Error fetching item ${element}`);
                return {
                  data: null,
                };
              });

            if (data) {
              items.push(data);
            }
          } else {
            console.log('Invalid element');
          }
        }

        console.log(`Fetched ${items.length} items for namespace ${namespace}`);

        /* return {
          elements: items,
          paging: {
            total: items.length,
            count: items.length,
            start: 0,
          },
        }; */
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

      // return data;
      return this.addHiddenItems(data, namespace);
    } catch (error) {
      if (error.response) {
        if (error.response.data) {
          const result = error.response.data;
          if (result && result.elements && result.paging) {
            return result;
          }
        }

        // If it's error 404, it means that the namespace doesn't exist
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
          // Token expired, reauthenticate
          console.log('Reauthenticating launcher...');
          this.launcher.logout();
          await this.launcher.init();
        }

        console.log(JSON.stringify(error.response, null, 2));
        console.log('Next attempt in 1s...');
        await this.sleep(5000);
        return this.fetchItemsForNamespace(...arguments);
      } else {
        throw new Error(error);
      }
    }
  }

  /**
   * Adds hidden items to the database based on the link {namespace}/{offerId}
   * It returns data too, but with the hidden items added to the elements array
   * @param {*} data
   * @param {*} namespace
   * @returns data
   */
  async addHiddenItems(data, namespace) {
    if (!this.nsIndex) {
      throw new Error('No namespace index found in this.nsIndex');
    }

    const offers = this.nsIndex[namespace];
    if (!offers) return data;

    console.log(
      `Trying to find hidden items for namespace ${namespace}... (offers: ${offers.length})`
    );

    const hiddenItems = [];
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

      /**
       * @returns {
       *    data: {
       *        Catalog: {
       *            offerSubItems: {
       *                namespace: string,
       *                id: string,
       *                releaseInfo: {
       *                  appId: string,
       *                  platform: string[]
       *                }[]
       *           }[]
       *       }
       *   }
       * }
       */
      const hiddenData = await this.fetchWithRetry(url.toString());
      const subItems = Array.isArray(hiddenData.data?.Catalog?.offerSubItems)
        ? hiddenData.data?.Catalog?.offerSubItems
        : [];

      if (subItems.length === 0) {
        continue;
      }

      // Get the IDs
      const hiddenItemsIds = subItems
        .map((item) => item.id)
        .filter((id) => id)
        .filter((id) => {
          return !data.elements.some((element) => element.id === id);
        });

      if (!hiddenItemsIds) {
        console.log('No hidden items found');
        continue;
      }

      // Get the items
      for await (const id of hiddenItemsIds) {
        const { data } = await this.fetchWithRetry(
          `https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/${namespace}/items/${id}`
        ).catch((error) => {
          console.error(`Error fetching item ${id}: ${error.message}`);
          return {
            data: null,
          };
        });

        if (data) {
          hiddenItems.push(data);
        }
        await this.sleep(1000);
      }
      await this.sleep(1000);
    }

    // Insert the items that are not already in the data
    const nonExistingItems = hiddenItems.filter(
      (item) => !data.elements.some((element) => element.id === item.id)
    );

    console.log(
      `Found ${nonExistingItems.length} hidden items for namespace ${namespace} (total: ${hiddenItems.length})`
    );

    data.elements = data.elements.concat(nonExistingItems);

    return data;
  }

  async fetchWithRetry(url, retries = 3) {
    let lastError = null;
    // Fetch the data with retries
    for (let i = 0; i < retries; i++) {
      try {
        const { data } = await this.launcher.http
          .sendGet(url)
          .then((response) => response);
        return data;
      } catch (error) {
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
          // if this message appears, we need to reauthenticate the launcher
          console.log('Reauthenticating launcher...');
          // close the launcher
          this.launcher.logout();
          // reinitialize the launcher
          await this.launcher.init();
          // retry the fetch
          continue;
        }

        lastError = error;
        console.log('Retrying...');
        await this.sleep(3000);
      }
    }

    throw new Error(`Failed to fetch data from ${url}: ${lastError.message}`);
  }
}

module.exports = new Main();
