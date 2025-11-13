(function () {
  "use strict";

  let TARGET_FOUND = false;
  let isSearching = false;

  const ERROR_MESSAGES = {
    400: "400 Bad Request: Invalid parameters",
    401: "301 Unauthorized: Authentication failed",
    403: "403 Forbidden: Access denied",
    404: "404 Not Found: User or server doesn't exist",
    429: "429 Rate Limited: Too many requests, please wait",
    500: "500 Server Error: Roblox backend issue, try again",
    503: "503 Service Unavailable: Roblox may be down",
  };

  const CONFIG = {
    BATCH_SIZE: 100,
    MAX_CONCURRENT_BATCHES: 1,
    DELAY_MS: 500,
    THUMB_TYPE: "AvatarHeadShot",
    THUMB_FORMAT: "png",
    THUMB_SIZE: "48x48",
    REQUEST_TIMEOUT: 10000,
    MAX_BACKOFF: 32000,
    INITIAL_BACKOFF: 1000,
    PAGE_LOAD_DELAY: 100,
  };

  const log = (type, s) =>
    console.log(`%c[RoSniper/${type}]`, "color:rgb(132, 0, 255);", s);
  const info = (s) => log("INFO", s);
  const error = (s) => log("ERROR", s);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeUrl = (url) => url.split("?")[0];
  const getAbortedResult = () => ({ found: false, aborted: true });
  const getErrorResult = (msg) => ({ found: false, error: msg });
  const formatError = (errorMsg) => {
    const statusCode = parseInt(errorMsg.split(" ")[0]);
    return ERROR_MESSAGES[statusCode] || `Error: ${errorMsg}`;
  };

  const countdownDelay = async (ms, onStatus, attempt = null) => {
    const seconds = Math.floor(ms / 1000);
    let remaining = seconds;
    const attemptText = attempt !== null ? ` (Attempt ${attempt})` : "";

    while (remaining > 0) {
      onStatus?.(`Rate limited, retrying in ${remaining}s${attemptText}`);
      await delay(1000);
      remaining--;
    }
    await delay(ms % 1000);
  };

  const calculateRateLimitDelay = (backoff) => {
    const seconds = Math.floor(backoff / 1000);
    return seconds * 1000 + Math.random() * 1000;
  };

  const getJSON = async (url, options = {}, onStatus = null) => {
    const controller = new AbortController();
    let timeoutId = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT
    );
    options.signal = controller.signal;

    const handleRateLimit = async (backoff, attempt) => {
      if (backoff >= CONFIG.MAX_BACKOFF)
        throw new Error("429 Too Many Requests - Max Retries Exceeded");
      const delayMs = calculateRateLimitDelay(backoff);

      await countdownDelay(delayMs, onStatus, attempt);
      timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

      return attemptRequest(
        Math.min(backoff * 2, CONFIG.MAX_BACKOFF),
        attempt + 1
      );
    };

    const attemptRequest = async (backoff = 0, attempt = 1) => {
      try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          if (res.status === 429) return handleRateLimit(backoff, attempt);
          throw new Error(`${res.status} ${res.statusText}`);
        }

        return res.json();
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") throw new Error("request timeout");
        if (err.message.includes("429"))
          return handleRateLimit(backoff, attempt);

        throw err;
      }
    };

    return attemptRequest(CONFIG.INITIAL_BACKOFF, 1);
  };

  const apiRequest = async (body, method = "POST", onStatus = null) => {
    return getJSON(
      "https://thumbnails.roblox.com/v1/batch",
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      onStatus
    );
  };

  const withErrorLog =
    (fn, errorMsg) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        error(errorMsg, e);
        throw e;
      }
    };

  const getUserId = withErrorLog(async (name, onStatus = null) => {
    const data = await getJSON(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }),
      },
      onStatus
    );
    return data.data?.[0]?.id || null;
  }, "user id fetch error:");

  const getThumb = withErrorLog(async (userId, onStatus = null) => {
    const data = await apiRequest(
      [
        {
          type: CONFIG.THUMB_TYPE,
          targetId: userId,
          format: CONFIG.THUMB_FORMAT,
          size: CONFIG.THUMB_SIZE,
        },
      ],
      "POST",
      onStatus
    );
    return data.data?.[0]?.imageUrl || null;
  }, "thumb fetch:");

  const getServers = withErrorLog(
    async (placeId, cursor = "", onStatus = null) => {
      const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=false&limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      return await getJSON(url, {}, onStatus);
    },
    "servers fetch:"
  );

  const fetchThumbs = withErrorLog(
    async (tokens, requestIds, onStatus = null) => {
      return await apiRequest(
        tokens.map((token, i) => ({
          type: CONFIG.THUMB_TYPE,
          targetId: 0,
          token,
          format: CONFIG.THUMB_FORMAT,
          size: CONFIG.THUMB_SIZE,
          requestId: requestIds[i],
        })),
        "POST",
        onStatus
      );
    },
    "thumbs fetch:"
  );

  const processBatch = async (batch, targetUrl, setStatus) => {
    try {
      if (TARGET_FOUND) return getAbortedResult();

      const profileRes = await fetchThumbs(
        batch.tokens,
        batch.requestIds,
        setStatus
      );
      if (!profileRes?.data) return { found: false };

      const profileMap = Object.fromEntries(
        profileRes.data
          .slice(0, batch.tokens.length)
          .map((p, j) => [
            batch.tokens[j],
            { imageUrl: p.imageUrl, requestId: p.requestId },
          ])
          .filter(([token, profile]) => token && profile?.imageUrl)
      );

      for (const token of batch.tokens) {
        if (TARGET_FOUND) return getAbortedResult();

        const profile = profileMap[token];
        if (
          profile?.imageUrl &&
          normalizeUrl(targetUrl) === normalizeUrl(profile.imageUrl)
        ) {
          setStatus(`Match found! Server: ${profile.requestId}`);
          TARGET_FOUND = true;
          return { found: true, serverId: profile.requestId, token };
        }
      }

      return { found: false };
    } catch (err) {
      if (TARGET_FOUND) return getAbortedResult();
      error(`batch:`, err);
      throw err;
    }
  };

  async function searchServers(
    placeId,
    targetUrl,
    cursor = "",
    pageNum = 1,
    setStatus
  ) {
    if (TARGET_FOUND) return getAbortedResult();

    try {
      setStatus(`Loading page ${pageNum}...`);
      await delay(CONFIG.PAGE_LOAD_DELAY);

      const serversRes = await getServers(placeId, cursor, setStatus);
      if (!serversRes?.data?.length) {
        setStatus(`No servers on page ${pageNum}`);
        return getErrorResult("No servers found");
      }

      if (TARGET_FOUND) return getAbortedResult();

      const servers = serversRes.data;
      const totalPlayers = servers.reduce(
        (sum, s) => sum + (s.playerTokens?.length || 0),
        0
      );
      setStatus(
        `Page ${pageNum}: ${servers.length} servers, ${totalPlayers} players`
      );

      servers.sort((a, b) => {
        const diff =
          (b.playerTokens?.length || 0) - (a.playerTokens?.length || 0);
        return diff !== 0 ? diff : (a.ping || 999) - (b.ping || 999);
      });

      const { allTokens, requestIds, serverMap } = servers.reduce(
        (acc, server) => {
          acc.serverMap[server.id] = server;
          if (server.playerTokens?.length) {
            server.playerTokens.forEach((token) => {
              acc.allTokens.push(token);
              acc.requestIds.push(server.id);
            });
          }

          return acc;
        },
        { allTokens: [], requestIds: [], serverMap: {} }
      );

      const batches = Array.from(
        { length: Math.ceil(allTokens.length / CONFIG.BATCH_SIZE) },
        (_, i) => ({
          tokens: allTokens.slice(
            i * CONFIG.BATCH_SIZE,
            (i + 1) * CONFIG.BATCH_SIZE
          ),
          requestIds: requestIds.slice(
            i * CONFIG.BATCH_SIZE,
            (i + 1) * CONFIG.BATCH_SIZE
          ),
        })
      );

      setStatus(`Processing ${batches.length} batches...`);

      for (
        let i = 0;
        i < batches.length && !TARGET_FOUND;
        i += CONFIG.MAX_CONCURRENT_BATCHES
      ) {
        const batchGroup = batches.slice(i, i + CONFIG.MAX_CONCURRENT_BATCHES);
        const results = await Promise.all(
          batchGroup.map((batch) => processBatch(batch, targetUrl, setStatus))
        );
        const matchResult = results.find((r) => r?.found);

        if (matchResult) {
          TARGET_FOUND = true;
          const foundServer = serverMap[matchResult.serverId];

          if (!foundServer) {
            error(`Server ${matchResult.serverId} not found in serverMap`);
            return getErrorResult("Server data not found");
          }

          setStatus(`Target found! Server: ${matchResult.serverId}`);
          info("server details:", foundServer);

          return { found: true, place: foundServer };
        }

        await delay(CONFIG.DELAY_MS);
      }

      if (TARGET_FOUND) return getAbortedResult();

      if (serversRes.nextPageCursor) {
        setStatus(`Loading page ${pageNum + 1}...`);
        return await searchServers(
          placeId,
          targetUrl,
          serversRes.nextPageCursor,
          pageNum + 1,
          setStatus
        );
      }

      setStatus("Target not found. Note: Avatar may differ if status is off");
      return getErrorResult("Target not found in any server");
    } catch (err) {
      setStatus(formatError(err.message));
      return getErrorResult(err.message);
    }
  }

  const search = async (placeId, name, setStatus, cb, setThumb) => {
    try {
      TARGET_FOUND = false;
      setStatus(`Searching for ${name}...`);

      const userId = await getUserId(name, setStatus);
      if (!userId) {
        setStatus("User not found");
        return cb(getErrorResult("User not found"));
      }

      const thumbUrl = await getThumb(userId, setStatus);
      if (!thumbUrl) {
        setStatus("Failed to get profile image");
        return cb(getErrorResult("Could not get profile image"));
      }

      setStatus(`Target: ${name} (ID: ${userId})`);
      setThumb(thumbUrl);

      const result = await searchServers(placeId, thumbUrl, "", 1, setStatus);
      if (result.found) {
        setStatus("Target found!");
        return cb(result);
      }

      if (TARGET_FOUND) {
        setStatus("Target found elsewhere");
        return cb(getErrorResult("Target found elsewhere"));
      }

      if (result.error) {
        return cb(getErrorResult(result.error));
      }

      setStatus("Target not found in any server");
      cb(getErrorResult("Target not found in any server"));
    } catch (err) {
      setStatus(formatError(err.message));
      cb(getErrorResult(err.message));
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
    Object.assign(form.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
    });

    const usernameInput = document.createElement("input");
    usernameInput.classList.add("input-field");
    usernameInput.placeholder = "Username";
    form.appendChild(usernameInput);

    const submitButton = document.createElement("button");
    Object.assign(submitButton, {
      className: "btn-primary-md",
      innerText: "Search",
      disabled: true,
    });
    Object.assign(submitButton.style, { height: "100%", margin: "0" });
    form.appendChild(submitButton);

    const thumbImage = document.createElement("img");
    Object.assign(thumbImage, { height: 40 });
    Object.assign(thumbImage.style, {
      display: "none",
      marginLeft: "8px",
      verticalAlign: "middle",
    });
    form.appendChild(thumbImage);
    containerHeader.appendChild(form);

    const statusContainer = document.createElement("div");
    Object.assign(statusContainer.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      marginTop: "0.5rem",
    });

    const statusText = document.createElement("span");
    statusContainer.appendChild(statusText);

    const joinBtn = document.createElement("button");
    Object.assign(joinBtn, {
      innerText: "Join Server",
      className:
        "btn-control-xs rbx-game-server-join game-server-join-btn btn-primary-md btn-min-width",
    });
    joinBtn.style.display = "none";
    statusContainer.appendChild(joinBtn);
    containerHeader.appendChild(statusContainer);

    usernameInput.addEventListener("input", (e) => {
      submitButton.disabled = e.target.value.trim().length === 0 || isSearching;
    });

    const placeId = location.href.match(/\d+/)?.[0];
    if (!placeId) {
      statusText.innerText = "Could not detect place id";
      return;
    }

    form.addEventListener("submit", (evt) => {
      evt.preventDefault();

      if (isSearching) return;

      isSearching = true;
      joinBtn.style.display = thumbImage.style.display = "none";
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
          isSearching = false;
          submitButton.disabled = usernameInput.value.trim().length === 0;
          submitButton.innerText = "Search";

          if (!result.found && result.error) return;
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
      ).catch((err) => {
        isSearching = false;
        submitButton.disabled = usernameInput.value.trim().length === 0;
        submitButton.innerText = "Search";

        error("Search error:", err);
      });
    });

    instancesContainer.insertBefore(
      containerHeader,
      instancesContainer.firstChild
    );
  };

  createUI();
})();
