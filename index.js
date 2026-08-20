const functions = require("@google-cloud/functions-framework");
const axios = require("axios");
const crypto = require("crypto");
const TRANSIT_URL = "https://api.anvui.vn/transit";
const TRANSIT_TEST_URL = "https://api-test.anvui.vn/transit";

const V4_URL = "https://api-beta.anvui.vn/v4";
const INTERNAL_TOKEN = "vnWQLzT9LL6A10llaVQICHZ1Brdmmz3TA6tYEoX";
const TEST_COMPANY = ["TC0BC1rJs03JKnvA", "TC08Z1qHHZBxlNLt"];

// Register a CloudEvent callback with the Functions Framework that will
// be executed when the Pub/Sub trigger topic receives a message.
functions.cloudEvent("exportTicket2TransitService", async (cloudEvent) => {
  let data = "";

  try {
    // The Pub/Sub message is passed as the CloudEvent's data payload.
    const base64name = cloudEvent.data.message.data;
    data = Buffer.from(base64name, "base64").toString();
    let ticket = JSON.parse(data);
    const reqData = [];
    const companyId = ticket?.company?.id;
    const ticketInfo = {
      ticketId: ticket.ticketId,
      ticketStatus: ticket.ticketStatus,
      ticketCode: ticket.ticketCode,
      phoneNumber: ticket.phoneNumber,
      ordererPhoneNumber: ticket.ordererPhoneNumber,
      fullName: ticket.fullName,
      routeId: ticket.routeId,
      companyId: ticket?.company?.id,
      companyName: ticket?.company?.name,
      sex: ticket?.sex,
      startDateReality: ticket?.getInTimePlanInt,
      isDeleted: false,
      note: ticket?.note,
      groupOrder: ticket?.transitGroupOrder,
    };
    console.log(ticket.ticketId, "Processing ticket with data:", data);
    // create pointDirection HOME_TO_STATION (pickup)
    // if (!ticket.pointUp?.usingAnvuiTransit && !ticket.pointDown?.usingAnvuiTransit) {
    //   return;
    // }

    if (ticket.pointUp && ticket.pointUp?.usingAnvuiTransit && ticket.ticketStatus !== 0) {
      const rData = await transformHome2Station(ticket, ticketInfo);
      rData && reqData.push(rData);
    } else if (ticket.pointUp) {
      // handle cancel order for HOME_TO_STATION
      const cancelData = await generateDeleteTransitTicket(ticket, "HOME_TO_STATION");
      cancelData && reqData.push({
        ...ticketInfo,
        ...cancelData
      });
    }

    // create pointDirection STATION_TO_HOME (dropoff)
    if (ticket.pointDown && ticket.pointDown?.usingAnvuiTransit && ticket.ticketStatus !== 0) {
      const rData = await transformStation2Home(ticket, ticketInfo);
      rData && reqData.push(rData);
    } else if (ticket.pointDown) {
      // handle cancel order for STATION_TO_HOME
      const cancelData = await generateDeleteTransitTicket(ticket, "STATION_TO_HOME");
      cancelData && reqData.push({
        ...ticketInfo,
        ...cancelData
      });
    }

    // handle cancel order
    if (reqData.length === 0) {
      //   console.log("No points to send to transit service");
      return;
    }

    let requestBody = JSON.stringify({
      data: [...reqData],
    });

    let transitUrl = TRANSIT_URL;
    if (TEST_COMPANY.includes(companyId)) {
      transitUrl = TRANSIT_TEST_URL;
    }

    console.log(ticket.ticketId, "----------", transitUrl, JSON.stringify(requestBody));

    let config = {
      method: "post",
      maxBodyLength: Infinity,
      url: transitUrl + "/api/v1/internal/transit-tickets",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
      data: requestBody,
    };

    const rs = await axios.request(config);
    console.log(ticket.ticketId, "Successfully sent transit tickets:", rs.status);
  } catch (e) {
    console.error(e.message);
    console.log(data);
    throw e;
  }
});

function hashPointId(longitude, latitude) {
  if (!longitude || !latitude) return null;

  // Round latitude and longitude to 6 decimal places before hashing to ensure consistent point ID generation
  const roundedLongitude = longitude; // Math.round(longitude * 1e6)
  const roundedLatitude = latitude; // Math.round(latitude * 1e6)
  const hash = crypto.createHash("md5");
  hash.update(`${roundedLongitude}${roundedLatitude}`);
  const hashValue = hash.digest("hex");
  return hashValue;
}

async function transformStation2Home(ticket, ticketInfo) {
  if (!ticket.pointDown?.id) {
    throw new Error(
      "Point down ID is required for STATION_TO_HOME transformation"
    );
  }

  const pointInfo = await getPointInfo(ticket.pointDown.id);
  if (!pointInfo) {
    return null;
  }

  if (ticket?.pointDown?.transshipmentPaymentStatus === "paid") {
    return null;
  }

  let reqData = {
    ...ticketInfo,
    pointDirection: "STATION_TO_HOME",
    startDateReality: 0,
    startTimeReality: 0,
    startTime: ticket.getOffTimePlan || 0,

    pickupAddress: pointInfo.addressText,
    pickupName: pointInfo.displayName,
    pickupType: pointInfo?.pointType,
    pickupWardId: pointInfo?.commune,
    pickupWardName: pointInfo?.communeName,
    pickupTransshipmentStatus: null,
    pickupLatitude: pointInfo?.latitude,
    pickupLongitude: pointInfo?.longitude,
    pickupPointId: pointInfo?.id,
    pickupProvinceId: ticket.pointDown?.provinceId,
    pickupProvinceName: ticket.pointDown?.province,
  };

  if ([1, 2].includes(ticket?.pointDown?.pointType)) {
    const hashPointIdValue = hashPointId(
      ticket.pointDown?.longitude,
      ticket.pointDown?.latitude
    );

    reqData = {
      ...reqData,
      // dropoff point
      dropoffAddress: ticket.pointDown.address,
      dropoffName: ticket.pointDown.name,
      dropoffType: ticket.pointDown?.pointType,
      dropoffWardId: ticket.pointDown?.wardId,
      dropoffWardName: ticket.pointDown?.wardName,
      dropoffTransshipmentStatus: ticket.pointDown?.transshipmentStatus,
      dropoffLatitude: ticket.pointDown?.latitude,
      dropoffLongitude: ticket.pointDown?.longitude,
      dropoffProvinceId: ticket.pointDown?.provinceId,
      dropoffProvinceName: ticket.pointDown?.province,
      dropoffPointId: hashPointIdValue,
    };
  }

  if (ticket?.pointDown?.pointType === 3 && ticket.pointDown?.transshipmentId) {
    const transshipmentPointAnvui = await getPointInfo(
      ticket.pointDown?.transshipmentId
    );
    if (!transshipmentPointAnvui) {
      return null;
    }
    reqData = {
      ...reqData,
      // dropoff point
      dropoffAddress: transshipmentPointAnvui.addressText,
      dropoffName: transshipmentPointAnvui.displayName,
      dropoffType: ticket.pointDown?.pointType,
      dropoffWardId: transshipmentPointAnvui?.commune,
      dropoffWardName: transshipmentPointAnvui?.communeName,
      dropoffTransshipmentStatus: ticket.pointDown?.transshipmentStatus,
      dropoffLatitude: transshipmentPointAnvui?.latitude,
      dropoffLongitude: transshipmentPointAnvui?.longitude,
      dropoffProvinceId: transshipmentPointAnvui?.province,
      dropoffProvinceName: transshipmentPointAnvui?.provinceName,
      dropoffPointId: transshipmentPointAnvui?.id,
    };
  }

  return reqData;
}

async function transformHome2Station(ticket, ticketInfo) {
  if (!ticket.pointUp?.id) {
    throw new Error(
      "Point up ID is required for HOME_TO_STATION transformation"
    );
  }

  const pointInfo = await getPointInfo(ticket.pointUp.id);
  if (!pointInfo) {
    return null;
  }

  if (ticket?.pointUp?.transshipmentPaymentStatus === "paid") {
    return null;
  }

  let reqData = {
    ...ticketInfo,
    pointDirection: "HOME_TO_STATION",
    startDateReality: 0,
    startTimeReality: 0,
    startTime: ticket.getInTimePlan || 0,
    // dropoff point
    dropoffAddress: pointInfo.addressText,
    dropoffName: pointInfo.displayName,
    dropoffType: pointInfo?.pointType,
    dropoffWardId: pointInfo?.commune,
    dropoffWardName: pointInfo?.communeName,
    dropoffTransshipmentStatus: null,
    dropoffLatitude: pointInfo?.latitude,
    dropoffLongitude: pointInfo?.longitude,
    dropoffPointId: pointInfo?.id,
    dropoffProvinceId: pointInfo?.province,
    dropoffProvinceName: pointInfo?.provinceName,
  };

  if ([1, 2].includes(ticket?.pointUp?.pointType)) {
    const hashPointIdValue = hashPointId(
      ticket.pointUp?.longitude,
      ticket.pointUp?.latitude
    );

    reqData = {
      ...reqData,
      // pickup point
      pickupAddress: ticket.pointUp.address,
      pickupName: ticket.pointUp.name,
      pickupType: ticket.pointUp?.pointType,
      pickupWardId: ticket.pointUp?.wardId,
      pickupWardName: ticket.pointUp?.wardName,
      pickupTransshipmentStatus: ticket.pointUp?.transshipmentStatus,
      pickupLatitude: ticket.pointUp?.latitude,
      pickupLongitude: ticket.pointUp?.longitude,
      pickupProvinceId: ticket.pointUp?.provinceId,
      pickupProvinceName: ticket.pointUp?.province,
      pickupPointId: hashPointIdValue,
    };
  }

  if (ticket?.pointUp?.pointType === 3 && ticket.pointUp?.transshipmentId) {
    const transshipmentPointAnvui = await getPointInfo(
      ticket.pointUp?.transshipmentId
    );

    if (!transshipmentPointAnvui) {
      return null;
    }
    reqData = {
      ...reqData,
      // pickup point
      pickupAddress: transshipmentPointAnvui.addressText,
      pickupName: transshipmentPointAnvui.displayName,
      pickupType: ticket.pointUp?.pointType,
      pickupWardId: transshipmentPointAnvui?.commune,
      pickupWardName: transshipmentPointAnvui?.communeName,
      pickupTransshipmentStatus: ticket.pointUp?.transshipmentStatus,
      pickupLatitude: transshipmentPointAnvui?.latitude,
      pickupLongitude: transshipmentPointAnvui?.longitude,
      pickupProvinceId: transshipmentPointAnvui?.province,
      pickupProvinceName: transshipmentPointAnvui?.provinceName,
      pickupPointId: transshipmentPointAnvui?.id,
    };
  }

  return reqData;
}


async function getPointInfo(pointId) {
  if (!pointId) {
    throw new Error("Point ID is required");
  }

  try {
    const rs2 = await axios.request({
      method: "get",
      maxBodyLength: Infinity,
      url: V4_URL + "/api/v1/internal/transit-anvui-stop-point/" + pointId,
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${INTERNAL_TOKEN}`,
      },
    });
    // console.log("getPointInfo: ", pointId, JSON.stringify(rs2.data))
    return rs2.data;
  } catch (error) {
    console.error(`Failed to get point info for ID ${pointId}:`, error.message);
  }
}

async function generateDeleteTransitTicket(ticket, pointDirection) {
  return {
    ticketId: ticket.ticketId,
    pointDirection: pointDirection,
    isDeleted: true,
  };
}