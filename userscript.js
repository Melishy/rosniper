(function () {
  "use strict";
  let TARGET_FOUND = false;

  const ERROR_MESSAGES = {
    400: "400 Bad Request\nInvalid parameters or request body, check your input though",
    401: "401 Unauthorized\nAuthentication issue (rare)",
    403: "403 Forbidden\nAccess Denied, possibly due to banned content or restrictions",
    404: "404 Not Found\nUser or server doesn't exist, double-check the username",
    429: "429 Too Many Requests\nYou're sniping your target too much, wait a bit and snipe again",
    500: "500 Internal Server Error\nProbably Roblox's backend issue, so wait and try again",
    503: "Service Unavailable\nRoblox could be down, so wait a bit and snipe again",
  };

  const CONFIG = {
    BATCH_SIZE: 100,
    MAX_CONCURRENT_BATCHES: 1,
    DELAY_MS: 500,
    THUMB_TYPE: "AvatarHeadShot",
    THUMB_FORMAT: "png",
    THUMB_SIZE: "48x48",
  };

  function info(s) {
    console.log("%c[RoSniper/INFO]", "color:rgb(132, 0, 255);", s);
  }

  function error(s) {
    console.log("%c[RoSniper/ERROR]", "color:rgb(132, 0, 255);", s);
  }

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const getJSON = async (url, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    options.signal = controller.signal;
    const attemptRequest = async (backoff = 0) => {
      try {
        clearTimeout(timeoutId);

        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        if (!res.ok) {
          if (res.status === 429) {
            const jitter = Math.random() * 1000;
            const delayMs = backoff + jitter;

            await delay(delayMs);
            return attemptRequest(Math.min(backoff * 2, 32000));
          }
          throw new Error(`${res.status} ${res.statusText}`);
        }

        return await res.json();
      } catch (error) {
        if (error.name === "AbortError") {
          throw new Error("request timeout");
        }

        if (error.message.includes("429")) {
          const jitter = Math.random() * 1000;
          const delayMs = backoff + jitter;

          await delay(delayMs);
          if (backoff >= 32000) {
            throw new Error("429 Too Many Requests - Max Retries Exceeded");
          }

          return attemptRequest(Math.min(backoff * 2, 32000));
        }

        throw error;
      }
    };

    return attemptRequest(1000);
  };

  const apiRequest = async (endpoint, body, method = "POST") => {
    return getJSON(`https://thumbnails.roblox.com/v1/batch`, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };

  const getUserId = async (name) => {
    try {
      const data = await getJSON(
        "https://users.roblox.com/v1/usernames/users",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            usernames: [name],
            excludeBannedUsers: true,
          }),
        }
      );

      return data.data?.[0]?.id || null;
    } catch (e) {
      error("user id fetch error:", e);
      throw e;
    }
  };

  const getThumb = async (userId) => {
    try {
      const data = await apiRequest(null, [
        {
          type: CONFIG.THUMB_TYPE,
          targetId: userId,
          format: CONFIG.THUMB_FORMAT,
          size: CONFIG.THUMB_SIZE,
        },
      ]);

      return data.data?.[0]?.imageUrl || null;
    } catch (e) {
      error("thumb fetch:", e);
      throw e;
    }
  };

  const getServers = async (placeId, cursor = "") => {
    let url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=false&limit=100`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    try {
      return await getJSON(url);
    } catch (e) {
      error("servers fetch:", e);
      throw e;
    }
  };

  const fetchThumbs = async (tokens, requestIds) => {
    const body = tokens.map((token, index) => ({
      type: CONFIG.THUMB_TYPE,
      targetId: 0,
      token: token,
      format: CONFIG.THUMB_FORMAT,
      size: CONFIG.THUMB_SIZE,
      requestId: requestIds[index],
    }));

    try {
      return await apiRequest(null, body);
    } catch (e) {
      error("thumbs fetch:", e);
      throw e;
    }
  };

  const normalizeUrl = (url) => url.split("?")[0];
  const processBatch = async (batch, targetUrl, setStatus) => {
    try {
      setStatus(`Starting batch with ${batch.tokens.length} tokens`);
      const profileRes = await fetchThumbs(batch.tokens, batch.requestIds);

      if (!profileRes?.data) {
        return {
          found: false,
        };
      }

      const profileMap = {};

      profileRes.data.forEach((profile, j) => {
        if (j < batch.tokens.length && profile.imageUrl) {
          profileMap[batch.tokens[j]] = {
            imageUrl: profile.imageUrl,
            requestId: profile.requestId,
          };
        }
      });

      for (let j = 0; j < batch.tokens.length; j++) {
        if (TARGET_FOUND) {
          return {
            found: false,
            aborted: true,
          };
        }

        const token = batch.tokens[j];
        const profile = profileMap[token];

        if (profile && profile.imageUrl) {
          const normTarget = normalizeUrl(targetUrl);
          const normPlayer = normalizeUrl(profile.imageUrl);

          if (normTarget === normPlayer) {
            const serverId = profile.requestId;

            setStatus(
              `\nMatch found! Token: ${token.slice(
                0,
                5
              )}... Server ID: ${serverId}`
            );

            TARGET_FOUND = true;

            return {
              found: true,
              serverId,
              token,
            };
          }
        }
      }

      return {
        found: false,
      };
    } catch (error) {
      if (TARGET_FOUND) {
        return {
          found: false,
          aborted: true,
        };
      }

      error(`batch:`, error);
      throw error;
    }
  };

  async function searchServers(
    placeId,
    targetUrl,
    cursor = "",
    pageNum = 1,
    setStatus
  ) {
    if (TARGET_FOUND) {
      return {
        found: false,
        aborted: true,
      };
    }

    try {
      setStatus(
        `Loading servers page ${pageNum}. Cursor: ${cursor || "initial"}`
      );

      await delay(100);
      const serversRes = await getServers(placeId, cursor);

      if (!serversRes || !serversRes.data || serversRes.data.length === 0) {
        setStatus(`No servers found on page ${pageNum}`);

        return {
          found: false,
          error: "No servers found",
        };
      }

      if (TARGET_FOUND) {
        return {
          found: false,
          aborted: true,
        };
      }

      const servers = serversRes.data;
      const totalPlayers = servers.reduce(
        (sum, s) => sum + s.playerTokens.length,
        0
      );

      setStatus(
        `Page ${pageNum}: Processing ${servers.length} servers with ${totalPlayers} players`
      );

      servers.sort((a, b) => {
        const playerDiff = b.playerTokens.length - a.playerTokens.length;
        if (playerDiff !== 0) return playerDiff;

        return (a.ping || 999) - (b.ping || 999);
      });

      const allTokens = [];
      const requestIds = [];
      const serverMap = {};

      for (const server of servers) {
        serverMap[server.id] = server;

        for (const token of server.playerTokens) {
          allTokens.push(token);
          requestIds.push(server.id);
        }
      }

      const batches = [];

      for (let i = 0; i < allTokens.length; i += CONFIG.BATCH_SIZE) {
        batches.push({
          tokens: allTokens.slice(i, i + CONFIG.BATCH_SIZE),
          requestIds: requestIds.slice(i, i + CONFIG.BATCH_SIZE),
        });
      }

      setStatus(
        `Processing ${batches.length} batches in groups of ${CONFIG.MAX_CONCURRENT_BATCHES}`
      );

      let matchFound = false;
      let foundServerId = null;

      for (
        let i = 0;
        i < batches.length && !matchFound && !TARGET_FOUND;
        i += CONFIG.MAX_CONCURRENT_BATCHES
      ) {
        if (TARGET_FOUND) break;
        const batchGroup = batches.slice(i, i + CONFIG.MAX_CONCURRENT_BATCHES);
        const batchPromises = batchGroup.map((batch) =>
          processBatch(batch, targetUrl, setStatus)
        );

        const results = await Promise.all(batchPromises);
        const matchResult = results.find((r) => r?.found);

        if (matchResult) {
          matchFound = true;
          foundServerId = matchResult.serverId;
          TARGET_FOUND = true;

          setStatus(
            `Found match in batch ${
              Math.floor(i / CONFIG.MAX_CONCURRENT_BATCHES) + 1
            }`
          );
          break;
        }

        await delay(CONFIG.DELAY_MS);
      }

      if (matchFound && foundServerId && serverMap[foundServerId]) {
        const foundServer = serverMap[foundServerId];

        setStatus(`\nTarget found! Server ID: ${foundServerId}`);
        info("server details:", foundServer);

        return {
          found: true,
          place: foundServer,
        };
      }
      if (TARGET_FOUND) {
        return {
          found: false,
          aborted: true,
        };
      }

      if (serversRes.nextPageCursor && !TARGET_FOUND) {
        setStatus(`Pre-fetching next page (${pageNum + 1})`);

        const nextResult = await searchServers(
          placeId,
          targetUrl,
          serversRes.nextPageCursor,
          pageNum + 1,
          setStatus
        );

        return nextResult;
      } else {
        setStatus("Finished all server pages! Target not found");

        return {
          found: false,
          error: "Target not found in any server",
        };
      }
    } catch (error) {
      const errorMsg = error.message;
      const statusCode = parseInt(errorMsg.split(" ")[0]);
      const fullMsg =
        ERROR_MESSAGES[statusCode] ||
        `${errorMsg}\nUps! An unknown error occurred, try again soon`;

      setStatus(fullMsg);

      return {
        found: false,
        error: errorMsg,
      };
    }
  }

  const search = async (placeId, name, setStatus, cb, setThumb) => {
    try {
      TARGET_FOUND = false;
      setStatus(`Starting search for ${name} in game ${placeId}`);

      const userId = await getUserId(name);
      if (!userId) {
        setStatus("User not found");

        return cb({
          found: false,
          error: "User not found",
        });
      }

      const thumbUrl = await getThumb(userId);

      if (!thumbUrl) {
        setStatus("Could not get profile image");

        return cb({
          found: false,
          error: "Could not get profile image",
        });
      }

      setStatus(`Target: ${name} ID: ${userId} Profile: ${thumbUrl}`);
      setThumb(thumbUrl);

      const result = await searchServers(placeId, thumbUrl, "", 1, setStatus);

      if (result.found) {
        setStatus("Target found!");

        cb(result);
      } else if (!TARGET_FOUND && !result.error) {
        setStatus("Target not found in any server");
        cb({
          found: false,
          error: "Target not found in any server",
        });
      } else if (TARGET_FOUND) {
        setStatus("Target found elsewhere");

        cb({
          found: false,
          error: "Target found elsewhere",
        });
      } else {
        cb({
          found: false,
          error: result.error || "Search failed",
        });
      }
    } catch (error) {
      const errorMsg = error.message;
      const statusCode = parseInt(errorMsg.split(" ")[0]);
      const fullMsg =
        ERROR_MESSAGES[statusCode] ||
        `${errorMsg}\nUps! An unknown error occurred, try again soon`;

      setStatus(fullMsg);
      cb({
        found: false,
        error: errorMsg,
      });
    }
  };

  const createUI = () => {
    const instancesContainer = document.getElementById(
      "running-game-instances-container"
    );

    if (!instancesContainer) {
      info("Not on a game page with instances container");
      return;
    }

    const containerHeader = document.createElement("div");
    containerHeader.classList.add("section");

    const form = document.createElement("form");
    form.style.display = "flex";
    form.style.alignItems = "center";
    form.style.gap = "8px";

    const usernameInput = document.createElement("input");
    usernameInput.classList.add("input-field");
    usernameInput.placeholder = "Username";
    form.appendChild(usernameInput);

    const submitButton = document.createElement("button");
    submitButton.classList.add("btn-primary-md");
    submitButton.innerText = "Search";
    submitButton.disabled = true;
    submitButton.style.height = "100%";
    submitButton.style.margin = "0";
    form.appendChild(submitButton);

    const thumbImage = document.createElement("img");
    thumbImage.height = "40";
    thumbImage.style.display = "none";
    thumbImage.style.marginLeft = "8px";
    thumbImage.style.verticalAlign = "middle";
    form.appendChild(thumbImage);
    containerHeader.appendChild(form);

    const statusContainer = document.createElement("div");
    statusContainer.style.display = "flex";
    statusContainer.style.alignItems = "center";
    statusContainer.style.gap = "8px";
    statusContainer.style.marginTop = "0.5rem";

    const statusText = document.createElement("span");
    statusContainer.appendChild(statusText);

    const joinBtn = document.createElement("button");
    joinBtn.style.display = "none";
    joinBtn.innerText = "Join Server";
    joinBtn.className =
      "btn-control-xs rbx-game-server-join game-server-join-btn btn-primary-md btn-min-width";
    statusContainer.appendChild(joinBtn);

    containerHeader.appendChild(statusContainer);

    usernameInput.addEventListener("input", (e) => {
      submitButton.disabled = e.target.value.length === 0;
    });

    const placeId = location.href.match(/\d+/)?.[0];

    if (!placeId) {
      statusText.innerText = "Could not detect place id";
      return;
    }

    form.addEventListener("submit", (evt) => {
      evt.preventDefault();

      joinBtn.style.display = "none";
      thumbImage.style.display = "none";
      submitButton.disabled = true;
      submitButton.innerText = "Searching";

      search(
        placeId,
        usernameInput.value.trim(),
        (txt) => {
          info(txt);
          statusText.innerText = txt;
        },

        (result) => {
          submitButton.disabled = false;
          submitButton.innerText = "Search";

          if (!result.found && result.error) {
            return;
          }

          if (!result.found) {
            statusText.innerText = "Couldn't find them";
            return;
          }

          joinBtn.style.display = "inline-block";
          joinBtn.onclick = () => {
            if (window.Roblox?.GameLauncher && result.place?.id) {
              window.Roblox.GameLauncher.joinGameInstance(
                placeId,
                result.place.id
              );
            } else {
              error(
                "Roblox.GameLauncher not available or no server ID, please join the game manually"
              );
            }
          };
        },

        (src) => {
          thumbImage.src = src;
          thumbImage.style.display = "inline-block";
        }
      );
    });

    instancesContainer.insertBefore(
      containerHeader,
      instancesContainer.firstChild
    );
  };

  createUI();
})();
