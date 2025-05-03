// Get record for the new booking.
let equipmentBookingsTable = base.getTable("Equipment Bookings");
let newBookingId = input.config().newBooking;

// Show the user that something is happening before doing async functions.
updateAvailabilityCheckField(newBookingId, "Checking...");

// Perform async function.
let newBooking = await getRecordsById(equipmentBookingsTable, [newBookingId]);

// Get record for relevant equipment.
let equipmentTable = base.getTable("Equipment");
let equipmentQuery = await equipmentTable.selectRecordsAsync({
  fields: equipmentTable.fields, 
  recordIds: [newBooking[0]["Equipment"][0].id]
});
let equipmentId = equipmentQuery.records[0].id;
let equipment = await getRecordsById(equipmentTable, [equipmentId]);
equipment = equipment[0];

// Get the maximum amount used on any date of the new booking.
let quantityUsed = await getEquipmentUsed(newBooking[0]);

// Get the total amount of equipment owned.
let totalEquipment = equipment["Total Owned"];

// Subtract the amount already being used from the total amount owned.
let quantityAvailable = totalEquipment - quantityUsed;

// Update the availability field.
if (quantityAvailable !== NaN) {
  updateAvailabilityCheckField(newBookingId, (
    quantityAvailable < newBooking[0]["Quantity"] ? 
    `Insufficient Availability (${quantityAvailable})` : 
    `Available (${quantityAvailable})`)
  );
} else {
  updateAvailabilityCheckField(newBookingId, `Error, ${quantityAvailable}`);
}



/**
 * Determine whether the new booking is possible given existing bookings that are already
 * using the requested equipment.
 * 
 * @param {object} booking - The object with the values for the booking that's been added.
 */
async function getEquipmentUsed(booking) {

  let query = await equipmentBookingsTable.selectRecordsAsync({fields: equipmentBookingsTable.fields});
  let existingBookings = await getRecordsById(equipmentBookingsTable, query.records.map(r => r.id));
  
  // Identify any existing bookings that might conflict with the new booking.
  let overlappingBookings = existingBookings.filter(eb => {

    // Don't include the new booking.
    if (eb.id == booking.id) {
      return false;
    }

    // Only consider existing bookings that have been confirmed.
    let statusMatch = eb["Status"].name == "Confirmed"

    // Ignore bookings relating to other equipment.
    let equipmentMatch = booking["Equipment"][0].id == eb["Equipment"][0].id;

    // For performance, skip date comparison if either of the other checks are false.
    if (statusMatch && equipmentMatch) {
        
      // Ignore bookings where there is no date overlap.
      let newDates = getDatesBetweenTwoDates(booking["Start Date"], booking["End Date"]);
      let existingDates = getDatesBetweenTwoDates(eb["Start Date"], eb["End Date"]);
      return newDates.some(d => existingDates.includes(d));

    } else {
      return false;
    }
  });

  // For all existing bookings that overlap, find the largest quantity of that piece of equipment that is out across the
  // dates for the new booking.
  let dates = getDatesBetweenTwoDates(booking["Start Date"], booking["End Date"]);

  let quantities = new Array();
  for (let date of dates) {
    let quantityBooked = 0;
    for (let ob of overlappingBookings) {
      let obDates = getDatesBetweenTwoDates(ob["Start Date"], ob["End Date"]);
      if (obDates.includes(date)) {
        quantityBooked += ob["Quantity"];
      }
    }
    quantities.push(quantityBooked);
  }

  return Math.max(...quantities);
}

/**
 * Convenience function to abbreviate updating the availability check indicator field for the user.
 * 
 * @param {String} value - The value to put in the availability check field.
 */
async function updateAvailabilityCheckField(id, value) {
  let equipmentBookingsTable = base.getTable("Equipment Bookings");
  equipmentBookingsTable.updateRecordAsync(id, {"Availability Check": value.toString()});
}




// -------------------------
// --- UTILITY FUNCTIONS ---
// -------------------------

/**
 * Gets full record object for a given list of IDs.
 * This compensates for the fact that AirTable doesn't return a list of records
 * as objects when a query is run. Basic functionality really...
 * 
 * @param {Table} table - The AirTable Table you want to get the record from.
 * @param {Array<string>} ids - A list of the record IDs you want to get.
 * @return {Promise<Array<object>>} - An async promise to return a list of records as objects.
 */
async function getRecordsById(table, ids) {
  
  // Select the relevant records in the given table. In Airtable this only returns a 
  // reference to the record, not the record values. Hence this function.
  let query = await table.selectRecordsAsync({fields: table.fields, recordIds: ids});
  
  // For each of the selected records, create a new object and populate values for all
  // fields in the table. Add the record to the list, and return that list.
  let records = new Array;
  for (let r of query.records) {
    let record = new Object;
    for (let field of table.fields) {
      record[field.name] = r.getCellValue(field);
    }
    record["id"] = r.id;
    records.push(record);
  }

  return records;
}


/**
 * Given two dates, returns a list of date objects for all dates including and in between
 * the start and end date.
 * 
 * @param {string | Date} start - The first date in the period.
 * @param {string | Date} end - The last date in the period.
 * @return {Array<string>} - A list of date strings in ISO format representing each day in the period, 
 * including the given start and end date.
 */
function getDatesBetweenTwoDates(start, end) {
  let dates = [];
  let startDate = new Date(start);
  let endDate = new Date(end);
  
  // Ensure the date objects are valid
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      console.error("Invalid dates provided");
      return dates;
  }

  while (startDate <= endDate) {
      dates.push(getDateAsISOString(new Date(startDate)));
      startDate.setDate(startDate.getDate() + 1);
  }

  return dates;
}


/**
 * Given a list of proposed entries to the given table, ensure that the proposed
 * entries haven't already been added. For each proposed record, this function checks 
 * whether all the fields, except the unique ID, match.
 * 
 * @param {Table} table - The table to check for duplicates.
 * @param {Array<{fields: object}>} records - The proposed records to add to the table.
 */
async function removeDuplicateRecords(table, records) {

  // Get existing records to compare against proposed records.
  let query = await table.selectRecordsAsync({fields: table.fields})
  let existingRecords = await getRecordsById(table, query.records.map(r => r.id))

  // Create an empty array to capture any genuinely new records.
  let newRecords = new Array();

  // Check criteria for each given proposed record.
  for (let record of records) {
    let matches = existingRecords.filter(er => {
        return compareRecords([record, er], table.fields.filter(f => {
          return f.type != "multipleLookupValues"
          }));
      });
    if (matches.length <= 0) {
      newRecords.push(record);
    }
  }

  return newRecords;
}


/**
 * Given a list of records of any length, compare the values of those records for each of the
 * given fields. Function returns try only if the values of the given fields match for every
 * record.
 * 
 * @param {Array<any>} records - A list of records to compare.
 * @param {Array<Field>} compareFields - A list of the fields to use in the comparison. Must
 * be proper Airtable field types, cannot accept field name strings.
 */
function compareRecords(records, compareFields) {
    
  let convertedRecords = records.map(r => convertRecordToObject(r));

  // Array to add comparison results to. Will use `.every()` function one this array at the 
  // end to determine whether the given records are the same.
  let results = new Array();

  // Iterate through each field and compare values for given records.
  for (let field of compareFields) {

    // Depending on the field type, normalise and compare the values for each record.
    let values = convertedRecords.map(record => {

      switch (field.type) {
        
        case 'multipleRecordLinks':
          let links = record[field.name].map(link => link.id).join(", ");
          return links;
        
        case 'date':
          return record[field.name];
        
        default:
          return record[field.name]
      }

    });

    // Push true or false to the results array depending on whether all the values in
    // the array match.
    results.push(values.every(v => v === values[0]))

    console.log(...values);
  }

  // Return true if every result is true, otherwise, return false.
  return results.every(Boolean);
}


/**
 * Given an Airtable record (ie, where all keys and values are hidden underneath a "fields" key), flatten the object
 * to remove the fields key.
 * 
 * @param {object} record - The record, which may or may not have a fields key.
 * @return {object} - The flattened object for the given record.
 */
function convertRecordToObject(record) {
  if (record.fields) {
    return { ...record.fields }
  }
  
  return record;
}


/**
 * Convert a given date object to an ISO string, cutting the time information off the end.
 * 
 * @param {Date} date - The date to convert to a string.
 * @return {string} - The date as a string, in the format YYYY-MM-DD.
 */
function getDateAsISOString(date) {
  return date.toISOString().slice(0, 10);
}